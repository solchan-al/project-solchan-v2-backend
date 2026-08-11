import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),
  FRONTEND_ORIGINS: z.string().default("http://localhost:3000,http://localhost:3001"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  SOLCHAN_ADMIN_WALLETS: z.string().default(""),
  STORAGE_ROOT: z.string().min(1).default("storage")
});

const parsed = EnvSchema.parse(process.env);

export const env = {
  ...parsed,
  SOLCHAN_ADMIN_WALLETS: parsed.SOLCHAN_ADMIN_WALLETS.split(",")
    .map((wallet) => wallet.trim())
    .filter(Boolean),
  FRONTEND_ORIGINS: Array.from(
    new Set(
      [parsed.FRONTEND_ORIGIN, ...parsed.FRONTEND_ORIGINS.split(",")]
        .map((origin) => origin.trim())
        .filter(Boolean)
    )
  )
};
