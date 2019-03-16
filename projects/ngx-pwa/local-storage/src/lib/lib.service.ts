import { Injectable, Inject } from '@angular/core';
import { Observable, throwError, of, OperatorFunction, ReplaySubject } from 'rxjs';
import { mergeMap, catchError, tap } from 'rxjs/operators';

import { LocalDatabase } from './databases/local-database';
import { LocalStorageDatabase } from './databases/localstorage-database';
import { JSONValidator } from './validation/json-validator';
import {
  JSONSchema, JSONSchemaBoolean, JSONSchemaInteger,
  JSONSchemaNumber, JSONSchemaString, JSONSchemaArrayOf
} from './validation/json-schema';
import { IDB_BROKEN_ERROR, ValidationError } from './exceptions';
import { LOCAL_STORAGE_PREFIX, LS_PREFIX } from './tokens';

/**
 * @deprecated Will be removed in v9
 */
export interface LSGetItemOptions {

  /**
   * Subset of the JSON Schema standard.
   * Types are enforced to validate everything: each value **must** have a `type`.
   * @see https://github.com/cyrilletuzi/angular-async-local-storage/blob/master/docs/VALIDATION.md
   */
  schema?: JSONSchema | null;

}

@Injectable({
  providedIn: 'root'
})
export class LocalStorage {

  private watched: Map<string, ReplaySubject<any>> = new Map();

  /**
   * Number of items in storage
   */
  get size(): Observable<number> {

    return this.database.size;

  }

  /**
   * Number of items in storage
   * Alias of `.size`
   */
  get length(): Observable<number> {

    return this.size;

  }

  /**
   * Constructor params are provided by Angular (but can also be passed manually in tests)
   * @param database Storage to use
   * @param jsonValidator Validator service
   * @param LSPrefix Prefix for `localStorage` keys to avoid collision for multiple apps on the same subdomain or for interoperability
   * @param oldPrefix Prefix option prior to v8 to avoid collision for multiple apps on the same subdomain or for interoperability
   */
  constructor(
    private database: LocalDatabase,
    private jsonValidator: JSONValidator = new JSONValidator(),
    @Inject(LS_PREFIX) private LSPrefix = '',
    // tslint:disable-next-line: deprecation
    @Inject(LOCAL_STORAGE_PREFIX) private oldPrefix = '',
  ) {}

  /**
   * Get an item value in storage.
   * The signature has many overloads due to validation, **please refer to the documentation.**
   * Note you must pass the schema directly as the second argument.
   * Passing the schema in an object `{ schema }` is deprecated and only here for backward compatibility:
   * it may be removed in v9.
   * @see https://github.com/cyrilletuzi/angular-async-local-storage/blob/master/docs/VALIDATION.md
   * @param key The item's key
   * @returns The item's value if the key exists, `null` otherwise, wrapped in a RxJS `Observable`
   */
  getItem<T = string>(key: string, schema: JSONSchemaString): Observable<string | null>;
  getItem<T = number>(key: string, schema: JSONSchemaInteger | JSONSchemaNumber): Observable<number | null>;
  getItem<T = boolean>(key: string, schema: JSONSchemaBoolean): Observable<boolean | null>;
  getItem<T = string[]>(key: string, schema: JSONSchemaArrayOf<JSONSchemaString>): Observable<string[] | null>;
  getItem<T = number[]>(key: string, schema: JSONSchemaArrayOf<JSONSchemaInteger | JSONSchemaNumber>): Observable<number[] | null>;
  getItem<T = boolean[]>(key: string, schema: JSONSchemaArrayOf<JSONSchemaBoolean>): Observable<boolean[] | null>;
  getItem<T = any>(key: string, schema: JSONSchema | { schema: JSONSchema }): Observable<T | null>;
  getItem<T = unknown>(key: string, schema?: null): Observable<unknown>;
  getItem<T = any>(key: string, schema: JSONSchema | { schema: JSONSchema } | null | undefined = null) {

    /* Get the data in storage */
    return this.database.getItem<T>(key).pipe(
      /* Check if `indexedDb` is broken */
      this.catchIDBBroken(() => this.database.getItem<T>(key)),
      mergeMap((data) => {

        if (data === null) {

          /* No need to validate if the data is `null` */
          return of(null);

        } else if (schema) {

          /* Backward compatibility with version <= 7 */
          const schemaFinal: JSONSchema = ('schema' in schema) ? schema.schema : schema;

          /* Validate data against a JSON schema if provied */
          if (!this.jsonValidator.validate(data, schemaFinal)) {
            return throwError(new ValidationError());
          }

          /* Data have been checked, so it's OK to cast */
          return of(data as T | null);

        }

        /* Cast to unknown as the data wasn't checked */
        return of(data as unknown);

      }),
    );

  }

  /**
   * Set an item in storage
   * @param key The item's key
   * @param data The item's value
   * @returns A RxJS `Observable` to wait the end of the operation
   */
  setItem(key: string, data: any): Observable<boolean> {

    return this.database.setItem(key, data)
      /* Catch if `indexedDb` is broken */
      .pipe(
        this.catchIDBBroken(() => this.database.setItem(key, data)),
        tap(() => { this.notify(key, data); }),
      );

  }

  /**
   * Delete an item in storage
   * @param key The item's key
   * @returns A RxJS `Observable` to wait the end of the operation
   */
  removeItem(key: string): Observable<boolean> {

    return this.database.removeItem(key)
      /* Catch if `indexedDb` is broken */
      .pipe(
        this.catchIDBBroken(() => this.database.removeItem(key)),
        tap(() => { this.notify(key, null); }),
      );

  }

  /**
   * Delete all items in storage
   * @returns A RxJS `Observable` to wait the end of the operation
   */
  clear(): Observable<boolean> {

    return this.database.clear()
      /* Catch if `indexedDb` is broken */
      .pipe(
        this.catchIDBBroken(() => this.database.clear()),
        tap(() => {
          this.watched.forEach((watched) => {
            watched.next(null);
          });
        }),
      );

  }

  /**
   * Get all keys stored in storage
   * @returns A list of the keys wrapped in a RxJS `Observable`
   */
  keys(): Observable<string[]> {

    return this.database.keys()
      /* Catch if `indexedDb` is broken */
      .pipe(this.catchIDBBroken(() => this.database.keys()));

  }

  /**
   * Tells if a key exists in storage
   * @returns A RxJS `Observable` telling if the key exists
   */
  has(key: string): Observable<boolean> {

    return this.database.has(key)
      /* Catch if `indexedDb` is broken */
      .pipe(this.catchIDBBroken(() => this.database.has(key)));

  }

  watchItem<T = string>(key: string, schema: JSONSchemaString): Observable<string | null>;
  watchItem<T = number>(key: string, schema: JSONSchemaInteger | JSONSchemaNumber): Observable<number | null>;
  watchItem<T = boolean>(key: string, schema: JSONSchemaBoolean): Observable<boolean | null>;
  watchItem<T = string[]>(key: string, schema: JSONSchemaArrayOf<JSONSchemaString>): Observable<string[] | null>;
  watchItem<T = number[]>(key: string, schema: JSONSchemaArrayOf<JSONSchemaInteger | JSONSchemaNumber>): Observable<number[] | null>;
  watchItem<T = boolean[]>(key: string, schema: JSONSchemaArrayOf<JSONSchemaBoolean>): Observable<boolean[] | null>;
  watchItem<T = any>(key: string, schema: JSONSchema): Observable<T | null>;
  watchItem<T = unknown>(key: string, schema?: null): Observable<unknown>;
  watchItem<T = any>(key: string, schema: JSONSchema | null | undefined = null) {

    if (!this.watched.has(key)) {

      const watched = new ReplaySubject<T | null>(1);

      this.watched.set(key, watched);

      this.getItem<T>(key, schema as JSONSchema).subscribe((data) => {
        watched.next(data);
      }, (error) => {
        watched.error(error);
      });

    }

    return (this.watched.get(key) as ReplaySubject<T | null>).asObservable();

  }

  /**
   * Set an item in storage, and auto-subscribe
   * @param key The item's key
   * @param data The item's value
   * **WARNING: should be avoided in most cases, use this method only if these conditions are fulfilled:**
   * - you don't need to manage the error callback (errors will silently fail),
   * - you don't need to wait the operation to finish before the next one (remember, it's asynchronous).
   */
  setItemSubscribe(key: string, data: string | number | boolean | object): void {

    this.setItem(key, data).subscribe({
      next: () => {},
      error: () => {},
    });

  }

  /**
   * Delete an item in storage, and auto-subscribe
   * @param key The item's key
   * **WARNING: should be avoided in most cases, use this method only if these conditions are fulfilled:**
   * - you don't need to manage the error callback (errors will silently fail),
   * - you don't need to wait the operation to finish before the next one (remember, it's asynchronous).
   */
   removeItemSubscribe(key: string): void {

    this.removeItem(key).subscribe({
      next: () => {},
      error: () => {},
    });

  }

  /**
   * Delete all items in storage, and auto-subscribe
   * **WARNING: should be avoided in most cases, use this method only if these conditions are fulfilled:**
   * - you don't need to manage the error callback (errors will silently fail),
   * - you don't need to wait the operation to finish before the next one (remember, it's asynchronous).
   */
  clearSubscribe(): void {

    this.clear().subscribe({
      next: () => {},
      error: () => {},
    });

  }

  private notify(key: string, value: any): void {

    if (this.watched.has(key)) {

      (this.watched.get(key) as ReplaySubject<any>).next(value);

    }

  }

  /**
   * RxJS operator to catch if `indexedDB` is broken
   * @param operationCallback Callback with the operation to redo
   */
  private catchIDBBroken<T>(operationCallback: () => Observable<T>): OperatorFunction<T, any> {

    return catchError((error) => {

      /* Check if `indexedDB` is broken based on error message (the specific error class seems to be lost in the process) */
      if ((error !== undefined) && (error !== null) && (error.message === IDB_BROKEN_ERROR)) {

        /* Fallback to `localStorage` */
        this.database = new LocalStorageDatabase(this.LSPrefix, this.oldPrefix);

        /* Redo the operation */
        return operationCallback();

      } else {

        /* Otherwise, rethrow the error */
        return throwError(error);

      }

    });

  }

}
