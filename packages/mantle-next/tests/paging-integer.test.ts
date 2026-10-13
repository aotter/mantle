import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { page, validCursor, type Paged } from "../src/kernel/paging.js";
import * as values from "../src/kernel/dialect/sqlite.js";

test("exact selected integer cursors are canonical, bounded and preserve SQLite order", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, n INTEGER); INSERT INTO entries VALUES ('a',9007199254740992),('b',9007199254740993),('c',9223372036854775807);");
    let reads = 0;
    const spec: Paged<Database> = {path:"exact-integers",cap:500,sqlite:true,cursor:["int","text"],keys:2,values,
      read:(db, sql, binds) => {reads++;return db.query(sql).all(...binds as any[]);},
      caller:{binds:[],first:{sql:"SELECT id,CAST(n AS TEXT) _k0,id _k1 FROM entries ORDER BY n,id LIMIT ?",extra:[-1]},next:{sql:"SELECT id,CAST(n AS TEXT) _k0,id _k1 FROM entries WHERE (n,id)>(?,?) ORDER BY n,id LIMIT ?",extra:[0,1,-1]}}};
    const caller = {kind:"system",reason:"native cursor oracle"} as const;
    const first = await page(spec,db,caller,{}, {limit:1});
    expect(first.rows).toEqual([{id:"a"}]);
    expect(JSON.parse(decodeURIComponent(first.nextCursor!))[0]).toBe("9007199254740992");
    const second = await page(spec,db,caller,{}, {limit:1,cursor:first.nextCursor});
    expect(second.rows).toEqual([{id:"b"}]);
    const third = await page(spec,db,caller,{}, {limit:1,cursor:second.nextCursor});
    expect(third.rows).toEqual([{id:"c"}]);expect(third.nextCursor).toBeUndefined();expect(reads).toBe(3);
    for (const key of ["", "01", "-0", "+1", "1.0", "1e2", " 1", "9223372036854775808", "-9223372036854775809", "9".repeat(1000), 9007199254740992]) {
      const cursor=encodeURIComponent(JSON.stringify([key,"a",spec.path]));
      await expect(page(spec,db,caller,{}, {cursor})).rejects.toMatchObject({code:"INPUT_VALIDATION_FAILED"});
    }
    expect(reads).toBe(3);
    for(const sqlite of [true,false]) {
      for(const key of ["0","-9223372036854775808","9223372036854775807",1])expect(validCursor("int",sqlite,key)).toBe(true);
      expect(validCursor("int4",sqlite,"2147483648")).toBe(false);expect(validCursor("int4",sqlite,"-2147483648")).toBe(true);
    }
  } finally {db.close();}
});
