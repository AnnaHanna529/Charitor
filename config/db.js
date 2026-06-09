const mysql = require("mysql2");

function railwaySsl(host) {
  const h = String(host || "").toLowerCase();
  if (process.env.DB_SSL === "0") return undefined;
  if (h.includes("rlwy.net") || h.includes("railway.internal")) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  connectTimeout: 30000,
  ssl: railwaySsl(process.env.DB_HOST),
});

db.connect((err) => {
  if (err) {
    console.error(
      "БД: не удалось подключиться при старте —",
      err.code || err.message,
    );
    process.exit(1);
  }
});

module.exports = db;