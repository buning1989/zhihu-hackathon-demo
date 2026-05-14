import express from "express";
import { fileURLToPath } from "node:url";
import { authRoutes } from "./auth/routes.js";
import { errorMiddleware, notFoundMiddleware } from "./middleware/error.middleware.js";
import { demoRoutes } from "./routes/demo.routes.js";
import { healthRoutes } from "./routes/health.routes.js";
import { personasRoutes } from "./routes/personas.routes.js";
import { searchRoutes } from "./routes/search.routes.js";
import { zhihuRoutes } from "./routes/zhihu.routes.js";

export const app = express();
const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));
const allowedCorsOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173"
]);

app.use((req, res, next) => {
  const origin = req.header("Origin");

  if (origin && allowedCorsOrigins.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.vary("Origin");
  }

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

app.use(express.json());
app.use(express.static(publicDir));
app.use("/preview", express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/health", healthRoutes);
app.use("/api/zhihu", zhihuRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/demo", demoRoutes);
app.use("/api/personas", personasRoutes);
app.use("/auth", authRoutes);

app.use(notFoundMiddleware);
app.use(errorMiddleware);
