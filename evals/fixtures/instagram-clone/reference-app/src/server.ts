import express, { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// ---------------------------------------------------------------------------
// In-memory "database" — no PostgreSQL required
// ---------------------------------------------------------------------------

interface User {
  id: number;
  username: string;
  email: string;
  password: string; // stored in plain text on purpose (another bug)
}

interface Post {
  id: number;
  userId: number;
  imageUrl: string;
  caption: string;
  createdAt: string;
}

const users: User[] = [
  { id: 1, username: "alice", email: "alice@example.com", password: "password123" },
  { id: 2, username: "bob", email: "bob@example.com", password: "hunter2" },
];

const posts: Post[] = [
  { id: 1, userId: 1, imageUrl: "/img/sunset.jpg", caption: "Beautiful sunset", createdAt: "2025-01-01T12:00:00Z" },
  { id: 2, userId: 2, imageUrl: "/img/coffee.jpg", caption: "Morning coffee", createdAt: "2025-01-02T08:00:00Z" },
];

let nextUserId = 3;
let nextPostId = 3;

// ---------------------------------------------------------------------------
// BUG: Hardcoded JWT secret (should come from env)
// ---------------------------------------------------------------------------
const JWT_SECRET = "super-secret-jwt-key-12345";

// ---------------------------------------------------------------------------
// Auth middleware (used by some routes, intentionally missing on POST /api/posts)
// ---------------------------------------------------------------------------
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing token" });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { sub: number };
    (req as any).userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Health check — works correctly
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// BUG: SQL-injection-style string interpolation on in-memory array.
// In a real DB this would be a SQL injection vector. The pattern is
// intentionally unsafe to trigger security reviewer findings.
app.get("/api/users/:id", (req: Request, res: Response) => {
  // eslint-disable-next-line no-eval
  const query = `users.find(u => u.id === ${req.params.id})`;
  const user = eval(query); // BUG: eval with user input
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const { password: _, ...safe } = user;
  res.json(safe);
});

// BUG: Hardcoded JWT secret used here
app.post("/api/login", (req: Request, res: Response) => {
  const { username, password } = req.body;
  const user = users.find((u) => u.username === username && u.password === password);
  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, username: user.username } });
});

// BUG: Missing requireAuth middleware — anyone can create posts
app.post("/api/posts", (req: Request, res: Response) => {
  const { imageUrl, caption, userId } = req.body;
  const post: Post = {
    id: nextPostId++,
    userId: userId ?? 0,
    imageUrl: imageUrl ?? "",
    caption: caption ?? "",
    createdAt: new Date().toISOString(),
  };
  posts.push(post);
  res.status(201).json(post);
});

// Protected route (correct usage of auth, for contrast)
app.get("/api/feed", requireAuth, (req: Request, res: Response) => {
  res.json(posts.slice().reverse());
});

// Serve minimal HTML page
app.get("/", (_req: Request, res: Response) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Instagram Clone</title></head>
<body>
  <h1>Instagram Clone (Reference App)</h1>
  <p>This is an intentionally buggy reference application for QA evaluation.</p>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3999;

app.listen(PORT, () => {
  console.log(`Reference app listening on http://localhost:${PORT}`);
});

export default app;
