import { Router } from "express";
import { z } from "zod";

import { pool } from "../db/pool.js";
import { WalletAddressSchema } from "../schemas/common.js";
import { canonicalJson } from "../services/canonical-json.js";
import { sha256Text } from "../services/hash.js";
import { storeAdminMetadata } from "../services/storage.js";

export const userRouter = Router();

userRouter.post("/metadata-documents", async (request, response) => {
  const BodySchema = z.object({
    content: z.record(z.unknown()),
    createdByWallet: WalletAddressSchema,
    recordKey: z.string().min(1).max(120)
  });
  const parsed = BodySchema.parse(request.body);
  const canonicalContent = canonicalJson(parsed.content);
  const contentHash = sha256Text(canonicalContent);
  const storagePath = await storeAdminMetadata(
    "user",
    "profile",
    parsed.recordKey,
    contentHash,
    canonicalContent
  );

  const result = await pool.query(
    `
      insert into admin_metadata_documents (
        record_type,
        record_kind,
        record_key,
        content_json,
        canonical_json,
        content_hash,
        storage_path,
        created_by_wallet
      )
      values ('user', 'profile', $1, $2, $3, $4, $5, $6)
      on conflict (content_hash) do update
      set content_json = excluded.content_json,
          canonical_json = excluded.canonical_json
      returning *
    `,
    [
      parsed.recordKey,
      parsed.content,
      canonicalContent,
      contentHash,
      storagePath,
      parsed.createdByWallet
    ]
  );

  response.status(201).json({
    metadataDocument: result.rows[0],
    metadataHash: contentHash,
    metadataUri: `/storage/${storagePath}`
  });
});
