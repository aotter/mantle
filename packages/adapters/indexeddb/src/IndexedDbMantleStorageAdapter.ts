import type { SchemaManifest } from "@aotter/mantle-spec";
import type {
  MantleStorageAdapter,
  PreparedMantleStorage,
  RuntimePlan,
} from "@aotter/mantle-runtime";
import { deleteDB, openDB } from "idb";
import {
  IndexedDbEntryRepository,
  type MantleIndexedDatabase,
  type MantleIndexedDbSchema,
} from "./IndexedDbEntryRepository.js";
import { IndexedDbViewQueryExecutor } from "./IndexedDbViewQueryExecutor.js";

const DATABASE_VERSION = 2;

export interface IndexedDbMantleStorageOptions {
  readonly databaseName: string;
}

/** Browser storage for one application-owned IndexedDB database. */
export class IndexedDbMantleStorageAdapter implements MantleStorageAdapter {
  readonly nativeViewDialects = [] as const;
  private connection: Promise<MantleIndexedDatabase> | undefined;

  constructor(private readonly options: IndexedDbMantleStorageOptions) {
    if (!options.databaseName.trim()) {
      throw new TypeError("IndexedDB databaseName must not be empty.");
    }
  }

  async prepare(plan: RuntimePlan): Promise<PreparedMantleStorage> {
    const schemas = new Map<string, SchemaManifest>(
      Object.values(plan.schemas).map((schema) => [schema.name, schema.manifest]),
    );
    const entries = new IndexedDbEntryRepository(() => this.database(), schemas);
    const views = new IndexedDbViewQueryExecutor(entries, plan);
    await this.database();
    return { entries, views };
  }

  /** Close this adapter and delete only its exclusively owned database. */
  async deleteDatabase(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (connection) (await connection.catch(() => undefined))?.close();
    await deleteDB(this.options.databaseName);
  }

  private database(): Promise<MantleIndexedDatabase> {
    if (this.connection) return this.connection;

    let opening!: Promise<MantleIndexedDatabase>;
    const forget = (): void => {
      if (this.connection === opening) this.connection = undefined;
    };
    opening = openDB<MantleIndexedDbSchema>(
      this.options.databaseName,
      DATABASE_VERSION,
      {
        upgrade(database, oldVersion, _newVersion, transaction) {
          const entries = oldVersion < 1
            ? database.createObjectStore("entries", { keyPath: "id" })
            : transaction.objectStore("entries");
          if (oldVersion < 2) {
            if (!entries.indexNames.contains("byCollection")) {
              entries.createIndex("byCollection", "collection");
            }
          }
        },
        blocking() {
          void opening.then((database) => database.close());
          forget();
        },
        terminated: forget,
      },
    );
    this.connection = opening;
    void opening.catch(forget);
    return opening;
  }
}
