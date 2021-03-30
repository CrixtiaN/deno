type MaybeString = string | undefined;
interface ReplitDBInterface {
  _DB_URL: MaybeString;
  DB_URL: string;
  set(key: string, value: string): Promise<boolean>;
  get(key: string): Promise<MaybeString>;
  delete(key: string): Promise<boolean>;
}
const replitDB: ReplitDBInterface = {
  _DB_URL: Deno.env.get("REPLIT_DB_URL"),
  get DB_URL() {
    if (this._DB_URL) {
      return this._DB_URL;
    }
    throw new Error("REPLIT_DB_URL is not available as an enviroment variable");
  },
  async set(key, value) {
    const params = new URLSearchParams();
    params.set(key, value);
    const response = await fetch(this.DB_URL, { method: "POST", body: params });
    return response.status === 200 ? true : false;
  },
  async get(key) {
    const response = await fetch(`${this.DB_URL}/${key}`, { method: "GET" });
    if (response.status === 200) {
      return response.text();
    }
  },
  async delete(key) {
    const response = await fetch(`${this.DB_URL}/${key}`, { method: "DELETE" });
    return response.status === 204 ? true : false;
  },
};
Object.freeze(replitDB);

if (import.meta.main) {
  const { parse } = await import("https://deno.land/std@0.90.0/flags/mod.ts");
  const args = parse(Deno.args, {
    boolean: ["delete"],
    alias: { delete: "d" },
  });
  const key = String(args._[0]);
  const value = String(args._[1]);
  switch (args._.length) {
    case 1:
      if (args.delete) {
        console.log(await replitDB.delete(key));
      } else {
        console.log(await replitDB.get(key));
      }
      break;
    case 2:
      console.log(await replitDB.set(key, value));
      break;
  }
}

export default replitDB;
