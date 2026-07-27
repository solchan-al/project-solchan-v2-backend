import { Router } from "express";
import { z } from "zod";

import { pool } from "../db/pool.js";
import { HttpError } from "../http/errors.js";
import { UuidParamsSchema, WalletAddressSchema } from "../schemas/common.js";

export const adminRouter = Router();

adminRouter.get("/accreditation-requests", async (_request, response) => {
  const result = await pool.query(`
    select
      ar.*,
      o.name as organization_name,
      o.wallet_address,
      count(ed.id)::integer as evidence_document_count
    from accreditation_requests_offchain ar
    join organizations_offchain o on o.id = ar.organization_id
    left join evidence_documents ed on ed.accreditation_request_id = ar.id
    group by ar.id, o.id
    order by ar.created_at desc
  `);

  response.json({ accreditationRequests: result.rows });
});

adminRouter.get("/accreditation-requests/:id", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);

  const requestResult = await pool.query(
    `
      select ar.*, o.name as organization_name, o.wallet_address, o.metadata_json
      from accreditation_requests_offchain ar
      join organizations_offchain o on o.id = ar.organization_id
      where ar.id = $1
    `,
    [id]
  );

  const accreditationRequest = requestResult.rows[0];
  if (!accreditationRequest) {
    throw new HttpError(404, "Accreditation request not found");
  }

  const documentsResult = await pool.query(
    `
      select *
      from evidence_documents
      where accreditation_request_id = $1
      order by created_at asc
    `,
    [id]
  );

  const manifestResult = await pool.query(
    `
      select *
      from evidence_manifests
      where accreditation_request_id = $1
      order by created_at desc
      limit 1
    `,
    [id]
  );

  const notesResult = await pool.query(
    `
      select *
      from admin_review_notes
      where accreditation_request_id = $1
      order by created_at desc
    `,
    [id]
  );

  response.json({
    accreditationRequest,
    documents: documentsResult.rows,
    evidenceManifest: manifestResult.rows[0] ?? null,
    notes: notesResult.rows
  });
});

adminRouter.post("/accreditation-requests/:id/notes", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);
  const BodySchema = z.object({
    adminWallet: WalletAddressSchema,
    note: z.string().min(1).max(4000)
  });
  const parsed = BodySchema.parse(request.body);

  const result = await pool.query(
    `
      insert into admin_review_notes (accreditation_request_id, admin_wallet, note)
      values ($1, $2, $3)
      returning *
    `,
    [id, parsed.adminWallet, parsed.note]
  );

  response.status(201).json({ note: result.rows[0] });
});

