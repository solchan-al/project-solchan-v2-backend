import { Router } from "express";

import { pool } from "../db/pool.js";

export const healthRouter = Router();

healthRouter.get("/", async (_request, response) => {
  await pool.query("select 1");
  response.json({ ok: true });
});

