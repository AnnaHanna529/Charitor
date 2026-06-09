/**
 * Экспорт Railway MySQL в .sql (без DBeaver и mysqldump).
 * 1) Создайте .env.railway.source с URL СТАРОЙ базы
 * 2) node scripts/export-railway-db.js
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env.railway.source"),
});

const outFile =
  process.env.RAILWAY_EXPORT_FILE ||
  path.resolve(__dirname, "../backup_railway.sql");

function parseMysqlUrl(url) {
  const u = new URL(url.replace(/^mysql:\/\//, "http://"));
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username || "root"),
    password: decodeURIComponent(u.password || ""),
    database: u.pathname.replace(/^\//, "") || "railway",
  };
}

function getConfig() {
  const url = process.env.RAILWAY_MYSQL_URL || process.env.RAILWAY_MYSQL_SOURCE_URL;
  if (url) {
    return parseMysqlUrl(url.trim());
  }
  return {
    host: process.env.RAILWAY_DB_HOST,
    port: Number(process.env.RAILWAY_DB_PORT || 3306),
    user: process.env.RAILWAY_DB_USER || "root",
    password: process.env.RAILWAY_DB_PASSWORD || "",
    database: process.env.RAILWAY_DB_NAME || "railway",
  };
}

function tableName(row) {
  return Object.values(row)[0];
}

async function main() {
  const cfg = getConfig();
  if (!cfg.host || !cfg.password) {
    console.error(
      "Создайте .env.railway.source в корне проекта:\n\n" +
        "RAILWAY_MYSQL_URL=mysql://root:ПАРОЛЬ@старый-хост:порт/railway\n\n" +
        "URL: старый Railway → MySQL → Connect → Public Network",
    );
    process.exit(1);
  }

  console.log(
    "Экспорт из:",
    cfg.user + "@" + cfg.host + ":" + cfg.port + "/" + cfg.database,
  );

  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectTimeout: 120000,
    ssl:
      process.env.RAILWAY_DB_SSL === "0"
        ? undefined
        : { rejectUnauthorized: false },
  });

  const chunks = [
    "-- Charitor.ai export",
    `-- ${new Date().toISOString()}`,
    "SET NAMES utf8mb4;",
    "SET FOREIGN_KEY_CHECKS=0;",
    "",
  ];

  const [tables] = await conn.query("SHOW TABLES");
  const names = tables.map(tableName);

  for (const name of names) {
    const [createRows] = await conn.query(`SHOW CREATE TABLE \`${name}\``);
    const createSql = createRows[0]["Create Table"];
    chunks.push(`DROP TABLE IF EXISTS \`${name}\`;`);
    chunks.push(createSql + ";");
    chunks.push("");

    const [rows] = await conn.query(`SELECT * FROM \`${name}\``);
    if (!rows.length) continue;

    const columns = Object.keys(rows[0]);
    const colList = columns.map((c) => `\`${c}\``).join(", ");

    for (const row of rows) {
      const values = columns.map((c) => conn.escape(row[c])).join(", ");
      chunks.push(`INSERT INTO \`${name}\` (${colList}) VALUES (${values});`);
    }
    chunks.push("");
    console.log("  ", name, "—", rows.length, "строк");
  }

  chunks.push("SET FOREIGN_KEY_CHECKS=1;");
  fs.writeFileSync(outFile, chunks.join("\n"), "utf8");

  const [users] = await conn.query("SELECT COUNT(*) AS n FROM users");
  await conn.end();

  console.log("\nГотово:", outFile);
  console.log("Таблиц:", names.length, "| users:", users[0].n);
  console.log("\nДальше: в .env.railway укажите НОВЫЙ URL и");
  console.log("RAILWAY_SQL_FILE=backup_railway.sql");
  console.log("node scripts/import-railway-db.js");
}

main().catch((err) => {
  console.error("Ошибка:", err.message);
  if (err.code === "ER_ACCESS_DENIED_ERROR") {
    console.error(
      "\n→ Проверьте пароль: Railway → MySQL → Settings → Reset Password",
    );
  }
  if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
    console.error("\n→ Включите Public Network у MySQL и скопируйте URL заново");
  }
  process.exit(1);
});
