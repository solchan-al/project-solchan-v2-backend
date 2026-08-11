import { Router, type NextFunction } from "express";
import { z } from "zod";

import { pool } from "../db/pool.js";
import { HttpError } from "../http/errors.js";
import { WalletAddressSchema } from "../schemas/common.js";
import { canonicalJson } from "../services/canonical-json.js";
import { assertWalletCanRegisterAs } from "../services/actor-identity.js";
import { sha256Text } from "../services/hash.js";
import { storeAdminMetadata } from "../services/storage.js";

export const userRouter = Router();

userRouter.get("/profiles/:account", async (request, response, next: NextFunction) => {
  const ParamsSchema = z.object({
    account: z.string().min(32).max(120)
  });
  try {
    const { account } = ParamsSchema.parse(request.params);

    const result = await pool.query(
      `
        select
          id,
          record_key as user_profile_account,
          content_json,
          content_hash,
          storage_path,
          created_by_wallet,
          created_at::text as created_at
        from admin_metadata_documents
        where record_type = 'user'
          and record_kind = 'profile'
          and record_key = $1
        order by created_at desc
        limit 1
      `,
      [account]
    );

    if (!result.rows[0]) {
      throw new HttpError(404, "User profile metadata not found");
    }

    response.json({ profile: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

userRouter.post("/metadata-documents", async (request, response, next: NextFunction) => {
  const BodySchema = z.object({
    content: z.record(z.unknown()),
    createdByWallet: WalletAddressSchema,
    recordKey: z.string().min(1).max(120)
  });
  try {
    const parsed = BodySchema.parse(request.body);
    await assertWalletCanRegisterAs(pool, parsed.createdByWallet, "user");

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
  } catch (error) {
    next(error);
  }
});
