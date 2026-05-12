import express from "express";
import { errorMiddleware, notFoundMiddleware } from "./middleware/error.middleware.js";
import { healthRoutes } from "./routes/health.routes.js";
import { searchRoutes } from "./routes/search.routes.js";
import { zhihuRoutes } from "./routes/zhihu.routes.js";

export const app = express();

app.use(express.json());

app.use("/api/health", healthRoutes);
app.use("/api/zhihu", zhihuRoutes);
app.use("/api/search", searchRoutes);

app.use(notFoundMiddleware);
app.use(errorMiddleware);
