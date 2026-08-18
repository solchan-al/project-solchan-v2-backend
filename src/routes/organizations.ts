import { Router, type NextFunction } from "express";
import { z } from "zod";

import { pool } from "../db/pool.js";
import { HttpError } from "../http/errors.js";
import { upload } from "../http/upload.js";
import { OptionalPublicKeySchema, UuidParamsSchema, WalletAddressSchema } from "../schemas/common.js";
import { assertWalletCanRegisterAs, getActorRegistration } from "../services/actor-identity.js";
import { canonicalJson } from "../services/canonical-json.js";
import { sha256File, sha256Text } from "../services/hash.js";
import { storeAdminMetadata, storeUploadedFile } from "../services/storage.js";

export const organizationRouter = Router();

organizationRouter.post("/metadata-documents", async (request, response, next: NextFunction) => {
  const BodySchema = z.object({
    content: z.record(z.unknown()),
    createdByWallet: WalletAddressSchema.optional(),
    recordKey: z.string().min(1).max(120)
  });
  try {
    const parsed = BodySchema.parse(request.body);
    if (parsed.createdByWallet) {
      const registration = await getActorRegistration(pool, parsed.createdByWallet);
      if (registration.status === "conflict") {
        throw new HttpError(
          409,
          "This wallet already has multiple identity records. Resolve the wallet identity conflict before creating organization metadata."
        );
      }
      if (registration.status === "registered" && registration.registration.actorType !== "organization") {
        throw new HttpError(
          409,
          "Only an organization wallet can create organization metadata."
        );
      }
    }

    const canonicalContent = canonicalJson(parsed.content);
    const contentHash = sha256Text(canonicalContent);
    const storagePath = await storeAdminMetadata(
      "organization",
      "identity",
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
        values ('organization', 'identity', $1, $2, $3, $4, $5, $6)
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
        parsed.createdByWallet ?? null
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

const CreateOrganizationSchema = z.object({
  walletAddress: WalletAddressSchema,
  organizationPda: OptionalPublicKeySchema,
  name: z.string().min(1).max(160),
  legalName: z.string().max(200).optional(),
  websiteUrl: z.string().url().optional(),
  description: z.string().max(2000).optional(),
  primaryOrganizationType: z.string().max(120).optional(),
  metadata: z.record(z.unknown()).default({})
});

const CreateAccreditationRequestSchema = z.object({
  organizationPda: OptionalPublicKeySchema,
  accreditationRequestPda: OptionalPublicKeySchema,
  criteriaBundleId: z.string().uuid().optional(),
  criteriaBundleHash: z.string().min(32).max(128).optional(),
  metadataUri: z.string().max(500).optional(),
  metadataHash: z.string().min(32).max(128).optional()
});

organizationRouter.post("/", async (request, response, next: NextFunction) => {
  const client = await pool.connect();
  try {
    const parsed = CreateOrganizationSchema.parse(request.body);
    const metadataHash = sha256Text(JSON.stringify(parsed.metadata));

    await client.query("begin");
    await assertWalletCanRegisterAs(client, parsed.walletAddress, "organization");

    const result = await client.query(
      `
        insert into organizations_offchain (
          wallet_address,
          organization_pda,
          name,
          legal_name,
          website_url,
          description,
          primary_organization_type,
          metadata_json,
          metadata_hash
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning *
      `,
      [
        parsed.walletAddress,
        parsed.organizationPda ?? null,
        parsed.name,
        parsed.legalName ?? null,
        parsed.websiteUrl ?? null,
        parsed.description ?? null,
        parsed.primaryOrganizationType ?? null,
        parsed.metadata,
        metadataHash
      ]
    );

    await createDefaultOrganizationContexts(client, result.rows[0].id, parsed.name);

    await client.query("commit");
    response.status(201).json({ organization: result.rows[0] });
  } catch (error) {
    await client.query("rollback");
    next(error);
  } finally {
    client.release();
  }
});

organizationRouter.get("/", async (_request, response) => {
  const result = await pool.query(`
    select
      o.*,
      count(ar.id)::integer as accreditation_request_count,
      latest.id as latest_accreditation_request_id,
      latest.accreditation_request_pda as latest_accreditation_request_pda,
      latest.criteria_bundle_hash as latest_criteria_bundle_hash,
      latest.evidence_manifest_hash as latest_evidence_manifest_hash,
      case
        when latest_manifest.manifest_storage_path is not null
          then '/storage/' || latest_manifest.manifest_storage_path
        else latest.metadata_uri
      end as latest_metadata_uri,
      latest.metadata_hash as latest_metadata_hash,
      latest.onchain_signature as latest_onchain_signature,
      latest.status::text as latest_accreditation_status
    from organizations_offchain o
    left join accreditation_requests_offchain ar on ar.organization_id = o.id
    left join lateral (
      select *
      from accreditation_requests_offchain latest
      where latest.organization_id = o.id
      order by latest.created_at desc
      limit 1
    ) latest on true
    left join evidence_manifests latest_manifest on latest_manifest.id = latest.evidence_manifest_id
    group by o.id
      , latest.id
      , latest.accreditation_request_pda
      , latest.criteria_bundle_hash
      , latest.evidence_manifest_hash
      , latest_manifest.manifest_storage_path
      , latest.metadata_uri
      , latest.metadata_hash
      , latest.onchain_signature
      , latest.status
    order by o.created_at desc
  `);

  response.json({ organizations: result.rows });
});

organizationRouter.get("/:id", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);

  const result = await pool.query("select * from organizations_offchain where id = $1", [id]);
  const organization = result.rows[0];

  if (!organization) {
    throw new HttpError(404, "Organization not found");
  }

  response.json({ organization });
});

organizationRouter.get("/by-pda/:account", async (request, response) => {
  const AccountParamsSchema = z.object({
    account: z.string().min(32).max(64)
  });
  const { account } = AccountParamsSchema.parse(request.params);

  const result = await pool.query(
    `
      select
        o.*,
        count(ar.id)::integer as accreditation_request_count,
        latest.id as latest_accreditation_request_id,
        latest.accreditation_request_pda as latest_accreditation_request_pda,
        latest.criteria_bundle_hash as latest_criteria_bundle_hash,
        latest.evidence_manifest_hash as latest_evidence_manifest_hash,
        case
          when latest_manifest.manifest_storage_path is not null
            then '/storage/' || latest_manifest.manifest_storage_path
          else latest.metadata_uri
        end as latest_metadata_uri,
        latest.metadata_hash as latest_metadata_hash,
        latest.onchain_signature as latest_onchain_signature,
        latest.status::text as latest_accreditation_status
      from organizations_offchain o
      left join accreditation_requests_offchain ar on ar.organization_id = o.id
      left join lateral (
        select *
        from accreditation_requests_offchain latest
        where latest.organization_id = o.id
        order by latest.created_at desc
        limit 1
      ) latest on true
      left join evidence_manifests latest_manifest on latest_manifest.id = latest.evidence_manifest_id
      where o.organization_pda = $1
      group by o.id
        , latest.id
        , latest.accreditation_request_pda
        , latest.criteria_bundle_hash
        , latest.evidence_manifest_hash
        , latest_manifest.manifest_storage_path
        , latest.metadata_uri
        , latest.metadata_hash
        , latest.onchain_signature
        , latest.status
    `,
    [account]
  );

  if (!result.rows[0]) {
    throw new HttpError(404, "Organization profile not found");
  }

  response.json({ organization: result.rows[0] });
});

organizationRouter.get("/:id/contexts", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);

  const result = await pool.query(
    `
      select
        id,
        organization_id,
        context_key,
        title,
        description,
        metadata_json,
        context_hash,
        status,
        created_at::text as created_at,
        updated_at::text as updated_at
      from organization_contexts
      where organization_id = $1 and status = 'active'
      order by context_key asc
    `,
    [id]
  );

  response.json({ contexts: result.rows });
});

organizationRouter.get("/:id/contexts/:contextId", async (request, response) => {
  const { id, contextId } = z.object({
    id: UuidParamsSchema.shape.id,
    contextId: UuidParamsSchema.shape.id
  }).parse(request.params);

  const result = await pool.query(
    `
      select
        c.id,
        c.organization_id,
        c.context_key,
        c.title,
        c.description,
        c.metadata_json,
        c.context_hash,
        c.status,
        c.created_at::text as created_at,
        c.updated_at::text as updated_at,
        o.name as organization_name,
        o.organization_pda
      from organization_contexts c
      join organizations_offchain o on o.id = c.organization_id
      where c.organization_id = $1 and c.id = $2
    `,
    [id, contextId]
  );

  const context = result.rows[0];
  if (!context) {
    throw new HttpError(404, "Organization validation context not found");
  }

  response.json({
    context: {
      contextHash: context.context_hash,
      description: context.description,
      key: context.context_key,
      metadata: context.metadata_json,
      organization: {
        id: context.organization_id,
        name: context.organization_name,
        protocolRecord: context.organization_pda
      },
      schema: "solchan.organization-context.v1",
      status: context.status,
      title: context.title,
      updatedAt: context.updated_at
    }
  });
});

organizationRouter.post("/:id/accreditation-requests", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);
  const parsed = CreateAccreditationRequestSchema.parse(request.body);

  const organization = await pool.query("select * from organizations_offchain where id = $1", [id]);
  if (!organization.rows[0]) {
    throw new HttpError(404, "Organization not found");
  }

  const result = await pool.query(
    `
      insert into accreditation_requests_offchain (
        organization_id,
        organization_pda,
        accreditation_request_pda,
        criteria_bundle_id,
        criteria_bundle_hash,
        metadata_uri,
        metadata_hash
      )
      values ($1, $2, $3, $4, $5, $6, $7)
      returning *
    `,
    [
      id,
      parsed.organizationPda ?? organization.rows[0].organization_pda,
      parsed.accreditationRequestPda ?? null,
      parsed.criteriaBundleId ?? null,
      parsed.criteriaBundleHash ?? null,
      parsed.metadataUri ?? null,
      parsed.metadataHash ?? null
    ]
  );

  response.status(201).json({ accreditationRequest: result.rows[0] });
});

organizationRouter.post(
  "/:id/evidence-documents",
  upload.array("documents", 10),
  async (request, response) => {
    const { id } = UuidParamsSchema.parse(request.params);
    const BodySchema = z.object({
      accreditationRequestId: z.string().uuid(),
      uploadedByWallet: WalletAddressSchema
    });
    const parsed = BodySchema.parse(request.body);
    const files = request.files as Express.Multer.File[] | undefined;

    if (!files?.length) {
      throw new HttpError(400, "At least one document is required");
    }

    const requestResult = await pool.query(
      `
        select *
        from accreditation_requests_offchain
        where id = $1 and organization_id = $2
      `,
      [parsed.accreditationRequestId, id]
    );

    if (!requestResult.rows[0]) {
      throw new HttpError(404, "Accreditation request not found");
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const documents = [];
      for (const file of files) {
        const stored = await storeUploadedFile(
          file.path,
          id,
          parsed.accreditationRequestId,
          file.originalname
        );
        const hash = await sha256File(stored.absolutePath);

        const documentResult = await client.query(
          `
            insert into evidence_documents (
              organization_id,
              accreditation_request_id,
              original_filename,
              stored_filename,
              storage_path,
              mime_type,
              byte_size,
              sha256_hash,
              uploaded_by_wallet
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            returning *
          `,
          [
            id,
            parsed.accreditationRequestId,
            file.originalname,
            stored.storedFilename,
            stored.storagePath,
            file.mimetype,
            file.size,
            hash,
            parsed.uploadedByWallet
          ]
        );
        documents.push(documentResult.rows[0]);
      }

      await client.query(
        `
          update accreditation_requests_offchain
          set status = 'evidence_uploaded', updated_at = now()
          where id = $1
        `,
        [parsed.accreditationRequestId]
      );

      await client.query("commit");
      response.status(201).json({ documents });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
);

async function createDefaultOrganizationContexts(
  client: Pick<typeof pool, "query">,
  organizationId: string,
  organizationName: string
) {
  const defaults = [
    {
      key: "membership",
      title: "Membership or participation",
      description: "The user asks the organization to confirm membership, participation, or community relationship."
    },
    {
      key: "course-completion",
      title: "Course completion",
      description: "The user asks the organization to confirm completion of a course, cohort, bootcamp, or learning track."
    },
    {
      key: "event-attendance",
      title: "Event attendance",
      description: "The user asks the organization to confirm attendance or participation in a specific event."
    }
  ];

  for (const context of defaults) {
    const metadata = {
      organization: organizationName,
      schema: "solchan.organization-context.v1",
      source: "default"
    };
    const contextHash = sha256Text(`${organizationId}:${context.key}`);

    await client.query(
      `
        insert into organization_contexts (
          organization_id,
          context_key,
          title,
          description,
          metadata_json,
          context_hash
        )
        values ($1, $2, $3, $4, $5, $6)
        on conflict (organization_id, context_key) do nothing
      `,
      [organizationId, context.key, context.title, context.description, metadata, contextHash]
    );
  }
}
