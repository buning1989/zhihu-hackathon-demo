import express from "express";
import { authRoutes } from "./auth/routes.js";
import { errorMiddleware, notFoundMiddleware } from "./middleware/error.middleware.js";
import { demoRoutes } from "./routes/demo.routes.js";
import { healthRoutes } from "./routes/health.routes.js";
import { searchRoutes } from "./routes/search.routes.js";
import { zhihuRoutes } from "./routes/zhihu.routes.js";

export const app = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "zhihu-hackathon-backend",
    version: "0.1.0"
  });
});

app.use("/api/health", healthRoutes);
app.use("/api/zhihu", zhihuRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/demo", demoRoutes);
app.use("/auth", authRoutes);

app.use(notFoundMiddleware);
app.use(errorMiddleware);
