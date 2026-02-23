import { Database } from "bun:sqlite";
const db = new Database("papotorto.sqlite");
const rows = db.query("SELECT id, num FROM rounds ORDER BY id DESC LIMIT 20").all();
console.log(rows);
