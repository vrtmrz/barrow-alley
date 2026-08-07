import type { Source, SourceItem } from "../core/files.js";
import { sha256Hex } from "../core/transfer/integrity.js";
import { MAX_BUFFERED_FILE_SIZE_BYTES } from "../core/transfer/limits.js";

/** Minimal TFile shape required by the host-neutral source adapter tests. */
export interface VaultBinaryFile {
  readonly path: string;
  readonly name: string;
  readonly extension: string;
  readonly stat: {
    readonly size: number;
    readonly mtime: number;
  };
}

/** Minimal Vault binary API used to keep the adapter independently testable. */
export interface VaultBinaryReader<TFile extends VaultBinaryFile = VaultBinaryFile> {
  readBinary(file: TFile): Promise<ArrayBuffer>;
}

export type VaultSourceErrorCode =
  | "EMPTY_SELECTION"
  | "DUPLICATE_FILE"
  | "FILE_TOO_LARGE"
  | "SOURCE_CHANGED"
  | "UNKNOWN_FILE";

/** A safe, actionable failure while preparing or reopening selected Vault files. */
export class VaultSourceError extends Error {
  readonly code: VaultSourceErrorCode;

  constructor(code: VaultSourceErrorCode, message: string) {
    super(message);
    this.name = "VaultSourceError";
    this.code = code;
  }
}

interface SelectedFile<TFile extends VaultBinaryFile> {
  readonly id: string;
  readonly file: TFile;
  readonly displayName: string;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  css: "text/css",
  csv: "text/csv",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  zip: "application/zip",
};

/**
 * Adapts an explicit Obsidian file selection to the domain Source contract.
 *
 * Obsidian exposes complete binary reads, so preparation hashes one complete
 * file at a time and enforces the shared 100 MiB buffer limit before reading.
 * Vault paths remain private: only generated IDs and basename-derived labels
 * reach the domain session.
 */
export class ObsidianVaultSource<TFile extends VaultBinaryFile = VaultBinaryFile> implements Source {
  readonly #reader: VaultBinaryReader<TFile>;
  readonly #selected: readonly SelectedFile<TFile>[];
  #prepared: readonly SourceItem[] | undefined;

  constructor(reader: VaultBinaryReader<TFile>, files: readonly TFile[]) {
    if (files.length === 0) {
      throw new VaultSourceError("EMPTY_SELECTION", "Select at least one file.");
    }
    const paths = new Set<string>();
    for (const file of files) {
      if (paths.has(file.path)) {
        throw new VaultSourceError("DUPLICATE_FILE", `The file '${file.name}' was selected twice.`);
      }
      paths.add(file.path);
    }

    this.#reader = reader;
    const displayNames = distinguishDuplicateNames(files.map((file) => file.name));
    this.#selected = files.map((file, index) => ({
      id: `source-${String(index + 1)}`,
      file,
      displayName: displayNames[index] ?? file.name,
    }));
  }

  async list(): Promise<readonly SourceItem[]> {
    if (this.#prepared !== undefined) return this.#prepared;

    const prepared: SourceItem[] = [];
    // Deliberately await inside the loop: at most one whole Vault file is held
    // for hashing at a time on hosts without a partial-read API.
    for (const selected of this.#selected) {
      assertSupportedSize(selected.file);
      const bytes = new Uint8Array(await this.#reader.readBinary(selected.file));
      if (bytes.byteLength !== selected.file.stat.size) {
        throw new VaultSourceError(
          "SOURCE_CHANGED",
          `The size of '${selected.displayName}' changed while the pitch was being prepared.`,
        );
      }
      const mimeType = MIME_TYPES[selected.file.extension.toLowerCase()];
      prepared.push({
        id: selected.id,
        displayName: selected.displayName,
        size: bytes.byteLength,
        ...(mimeType === undefined ? {} : { mimeType }),
        hash: await sha256Hex(bytes),
        sourceVersion: `${String(selected.file.stat.mtime)}:${String(selected.file.stat.size)}`,
      });
    }
    this.#prepared = prepared;
    return prepared;
  }

  async open(itemId: string): Promise<Uint8Array> {
    const selected = this.#selected.find(({ id }) => id === itemId);
    if (selected === undefined) {
      throw new VaultSourceError("UNKNOWN_FILE", "The requested selected file is not available.");
    }
    assertSupportedSize(selected.file);
    return new Uint8Array(await this.#reader.readBinary(selected.file));
  }
}

function assertSupportedSize(file: VaultBinaryFile): void {
  if (file.stat.size > MAX_BUFFERED_FILE_SIZE_BYTES) {
    throw new VaultSourceError(
      "FILE_TOO_LARGE",
      `'${file.name}' exceeds the 100 MiB file limit.`,
    );
  }
}

function distinguishDuplicateNames(names: readonly string[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);

  const seen = new Map<string, number>();
  return names.map((name) => {
    if ((counts.get(name) ?? 0) === 1) return name;
    const occurrence = (seen.get(name) ?? 0) + 1;
    seen.set(name, occurrence);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    return `${stem} (${String(occurrence)})${extension}`;
  });
}
