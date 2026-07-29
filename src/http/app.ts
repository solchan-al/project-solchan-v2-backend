import cors from "cors";
import express from "express";
import path from "node:path";

import { env } from "../config/env.js";
import { accreditationRouter } from "../routes/accreditation.js";
import { adminRouter } from "../routes/admin.js";
import { healthRouter } from "../routes/health.js";
import { organizationRouter } from "../routes/organizations.js";
import { socialRouter } from "../routes/social.js";
import { errorHandler, notFound } from "./errors.js";

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.FRONTEND_ORIGINS.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`CORS origin not allowed: ${origin}`));
      }
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use("/storage", express.static(path.resolve(process.cwd(), env.STORAGE_ROOT)));

  app.use("/health", healthRouter);
  app.use("/organizations", organizationRouter);
  app.use("/accreditation-requests", accreditationRouter);
  app.use("/admin", adminRouter);
  app.use("/social", socialRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
