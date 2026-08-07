import type {
  IncomingFileMeta,
  IncomingFileWriter,
  Sink,
  Source,
  SourceItem,
} from "../../src/core/index.js";

/** Declarative source file used by host-neutral integration tests. */
export interface InMemorySourceFile {
  readonly id: string;
  readonly displayName: string;
  readonly mimeType?: string;
  readonly hash: string;
  readonly chunks: readonly Uint8Array[];
}

interface StoredSourceFile {
  readonly metadata: SourceItem;
  readonly chunks: readonly Uint8Array[];
}

export class InMemorySource implements Source {
  readonly #files = new Map<string, StoredSourceFile>();

  constructor(files: readonly InMemorySourceFile[]) {
    for (const file of files) {
      if (this.#files.has(file.id)) throw new Error(`Duplicate in-memory source ID: ${file.id}.`);
      const size = file.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const base = { id: file.id, displayName: file.displayName, size, hash: file.hash };
      this.#files.set(file.id, {
        metadata: file.mimeType === undefined ? base : { ...base, mimeType: file.mimeType },
        chunks: file.chunks.map((chunk) => chunk.slice()),
      });
    }
  }

  async list(): Promise<readonly SourceItem[]> {
    return [...this.#files.values()].map((file) => file.metadata);
  }

  async open(itemId: string): Promise<AsyncIterable<Uint8Array>> {
    const file = this.#files.get(itemId);
    if (file === undefined) throw new Error(`Unknown in-memory source ID: ${itemId}.`);
    return emitChunks(file.chunks);
  }
}

/** Completed destination captured by `InMemorySink` for behavioural assertions. */
export interface CompletedInMemoryFile {
  readonly meta: IncomingFileMeta;
  readonly bytes: Uint8Array;
}

export class InMemorySink implements Sink {
  readonly completed = new Map<string, CompletedInMemoryFile>();
  readonly aborted = new Set<string>();

  async begin(meta: IncomingFileMeta): Promise<IncomingFileWriter> {
    const chunks: Uint8Array[] = [];
    let finished = false;
    return {
      write: async (chunk) => {
        if (finished) throw new Error("Cannot write to a finished in-memory file.");
        chunks.push(chunk.slice());
      },
      complete: async () => {
        if (finished) throw new Error("Cannot complete a finished in-memory file.");
        finished = true;
        this.completed.set(meta.id, { meta, bytes: concatenate(chunks) });
      },
      abort: async () => {
        if (finished) return;
        finished = true;
        this.aborted.add(meta.id);
      },
    };
  }
}

async function* emitChunks(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk.slice();
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
