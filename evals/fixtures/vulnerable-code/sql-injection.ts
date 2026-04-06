import express from "express";
import { Pool } from "pg";

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// VULNERABILITY: String interpolation in SQL query
app.get("/api/users/:id", async (req, res) => {
  const result = await pool.query(`SELECT * FROM users WHERE id = ${req.params.id}`);
  res.json(result.rows[0]);
});

// VULNERABILITY: Template literal with user input in WHERE clause
app.get("/api/search", async (req, res) => {
  const { q } = req.query;
  const result = await pool.query(`SELECT * FROM posts WHERE caption LIKE '%${q}%'`);
  res.json(result.rows);
});

// SAFE: Parameterized query (for contrast)
app.get("/api/posts/:id", async (req, res) => {
  const result = await pool.query("SELECT * FROM posts WHERE id = $1", [req.params.id]);
  res.json(result.rows[0]);
});

export default app;
