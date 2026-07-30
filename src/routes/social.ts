import { Router } from "express";
import { z } from "zod";

import { pool } from "../db/pool.js";
import { HttpError } from "../http/errors.js";
import { OptionalPublicKeySchema, UuidParamsSchema, WalletAddressSchema } from "../schemas/common.js";
import { canonicalJson } from "../services/canonical-json.js";
import { sha256Text } from "../services/hash.js";

export const socialRouter = Router();

const AuthorSchema = z.object({
  authorType: z.enum(["user", "organization", "admin"]),
  authorWallet: WalletAddressSchema,
  userProfileAccount: OptionalPublicKeySchema,
  organizationAccount: OptionalPublicKeySchema
});

const ContentSchema = z
  .object({
    title: z.string().min(1).max(180).optional(),
    body: z.string().min(1).max(20000),
    summary: z.string().max(500).optional(),
    tags: z.array(z.string().min(1).max(40)).max(12).default([])
  })
  .strict();

const TrustSnapshotSchema = z.record(z.unknown()).default({});

const CreatePostSchema = AuthorSchema.extend({
  contentKind: z.enum(["post", "article"]).default("post"),
  content: ContentSchema,
  authorTrustSnapshot: TrustSnapshotSchema
});

const EditPostSchema = z.object({
  contentKind: z.enum(["post", "article"]).default("post"),
  content: ContentSchema,
  authorTrustSnapshot: TrustSnapshotSchema,
  editReason: z.string().max(500).optional()
});

const CreateCommentSchema = AuthorSchema.extend({
  parentCommentId: z.string().uuid().optional(),
  content: ContentSchema.pick({ body: true }),
  authorTrustSnapshot: TrustSnapshotSchema
});

const EditCommentSchema = z.object({
  content: ContentSchema.pick({ body: true }),
  authorTrustSnapshot: TrustSnapshotSchema,
  editReason: z.string().max(500).optional()
});

const ListPostsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10)
});

function buildVersionPayload(input: {
  authorTrustSnapshot: Record<string, unknown>;
  content: Record<string, unknown>;
  contentKind?: "post" | "article";
  schema: string;
}) {
  return {
    authorTrustSnapshot: input.authorTrustSnapshot,
    content: input.content,
    contentKind: input.contentKind,
    schema: input.schema
  };
}

function hashVersion(input: {
  authorTrustSnapshot: Record<string, unknown>;
  content: Record<string, unknown>;
  contentKind?: "post" | "article";
  schema: string;
}) {
  const canonical = canonicalJson(buildVersionPayload(input));
  return {
    canonical,
    hash: sha256Text(canonical)
  };
}

function buildPostsCursor(row: { created_at: Date | string; id: string }) {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  return Buffer.from(`${createdAt}|${row.id}`, "utf8").toString("base64url");
}

function parsePostsCursor(cursor?: string) {
  if (!cursor) return null;

  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [createdAt, id] = decoded.split("|");
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

socialRouter.post("/posts", async (request, response) => {
  const parsed = CreatePostSchema.parse(request.body);
  const { canonical, hash } = hashVersion({
    authorTrustSnapshot: parsed.authorTrustSnapshot,
    content: parsed.content,
    contentKind: parsed.contentKind,
    schema: "solchan.social-post-version.v1"
  });

  const client = await pool.connect();
  try {
    await client.query("begin");

    const postResult = await client.query(
      `
        insert into social_posts (
          author_type,
          author_wallet,
          user_profile_account,
          organization_account
        )
        values ($1, $2, $3, $4)
        returning *
      `,
      [
        parsed.authorType,
        parsed.authorWallet,
        parsed.userProfileAccount ?? null,
        parsed.organizationAccount ?? null
      ]
    );
    const post = postResult.rows[0];

    const versionResult = await client.query(
      `
        insert into social_post_versions (
          post_id,
          version_number,
          content_kind,
          content_json,
          canonical_json,
          content_hash,
          author_trust_snapshot
        )
        values ($1, 1, $2, $3, $4, $5, $6)
        returning *
      `,
      [post.id, parsed.contentKind, parsed.content, canonical, hash, parsed.authorTrustSnapshot]
    );
    const version = versionResult.rows[0];

    const updatedPostResult = await client.query(
      `
        update social_posts
        set current_version_id = $2,
            updated_at = now()
        where id = $1
        returning *
      `,
      [post.id, version.id]
    );

    await client.query("commit");
    response.status(201).json({ post: updatedPostResult.rows[0], version });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
});

socialRouter.get("/posts", async (request, response) => {
  const parsed = ListPostsQuerySchema.parse(request.query);
  const cursor = parsePostsCursor(parsed.cursor);
  const params: unknown[] = [parsed.limit + 1];
  let cursorWhere = "";

  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    cursorWhere = "and (p.created_at, p.id) < ($2::timestamptz, $3::uuid)";
  }

  const result = await pool.query(
    `
      select
        p.*,
        v.version_number as current_version_number,
        v.content_kind,
        v.content_json,
        v.content_hash,
        v.author_trust_snapshot,
        v.created_at as current_version_created_at,
        count(c.id)::integer as comment_count
      from social_posts p
      join social_post_versions v on v.id = p.current_version_id
      left join social_comments c on c.post_id = p.id and c.status = 'active'
      where p.status = 'active'
      ${cursorWhere}
      group by p.id, v.id
      order by p.created_at desc, p.id desc
      limit $1
    `,
    params
  );
  const rows = result.rows.slice(0, parsed.limit);
  const last = rows.at(-1);

  response.json({
    nextCursor: result.rows.length > parsed.limit && last ? buildPostsCursor(last) : null,
    posts: rows
  });
});

socialRouter.get("/posts/:id", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);

  const postResult = await pool.query(
    `
      select
        p.*,
        v.version_number as current_version_number,
        v.content_kind,
        v.content_json,
        v.content_hash,
        v.author_trust_snapshot,
        v.created_at as current_version_created_at
      from social_posts p
      join social_post_versions v on v.id = p.current_version_id
      where p.id = $1
    `,
    [id]
  );
  const post = postResult.rows[0];
  if (!post) {
    throw new HttpError(404, "Post not found");
  }

  const versionsResult = await pool.query(
    `
      select *
      from social_post_versions
      where post_id = $1
      order by version_number desc
    `,
    [id]
  );

  const commentsResult = await pool.query(
    `
      select
        c.*,
        v.version_number as current_version_number,
        v.content_json,
        v.content_hash,
        v.author_trust_snapshot,
        v.created_at as current_version_created_at
      from social_comments c
      join social_comment_versions v on v.id = c.current_version_id
      where c.post_id = $1 and c.status = 'active'
      order by c.created_at asc
    `,
    [id]
  );

  response.json({
    comments: commentsResult.rows,
    post,
    versions: versionsResult.rows
  });
});

socialRouter.post("/posts/:id/versions", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);
  const parsed = EditPostSchema.parse(request.body);
  const { canonical, hash } = hashVersion({
    authorTrustSnapshot: parsed.authorTrustSnapshot,
    content: parsed.content,
    contentKind: parsed.contentKind,
    schema: "solchan.social-post-version.v1"
  });

  const client = await pool.connect();
  try {
    await client.query("begin");

    const currentResult = await client.query(
      `
        select p.*, v.id as previous_version_id, v.version_number as previous_version_number
        from social_posts p
        join social_post_versions v on v.id = p.current_version_id
        where p.id = $1
        for update
      `,
      [id]
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new HttpError(404, "Post not found");
    }

    const versionResult = await client.query(
      `
        insert into social_post_versions (
          post_id,
          version_number,
          content_kind,
          content_json,
          canonical_json,
          content_hash,
          previous_version_id,
          author_trust_snapshot,
          edit_reason
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning *
      `,
      [
        id,
        Number(current.previous_version_number) + 1,
        parsed.contentKind,
        parsed.content,
        canonical,
        hash,
        current.previous_version_id,
        parsed.authorTrustSnapshot,
        parsed.editReason ?? null
      ]
    );
    const version = versionResult.rows[0];

    const postResult = await client.query(
      `
        update social_posts
        set current_version_id = $2,
            updated_at = now()
        where id = $1
        returning *
      `,
      [id, version.id]
    );

    await client.query("commit");
    response.status(201).json({ post: postResult.rows[0], version });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
});

socialRouter.post("/posts/:id/comments", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);
  const parsed = CreateCommentSchema.parse(request.body);
  const { canonical, hash } = hashVersion({
    authorTrustSnapshot: parsed.authorTrustSnapshot,
    content: parsed.content,
    schema: "solchan.social-comment-version.v1"
  });

  const client = await pool.connect();
  try {
    await client.query("begin");

    const postResult = await client.query("select id from social_posts where id = $1", [id]);
    if (!postResult.rows[0]) {
      throw new HttpError(404, "Post not found");
    }

    if (parsed.parentCommentId) {
      const parentResult = await client.query(
        "select id from social_comments where id = $1 and post_id = $2",
        [parsed.parentCommentId, id]
      );
      if (!parentResult.rows[0]) {
        throw new HttpError(404, "Parent comment not found");
      }
    }

    const commentResult = await client.query(
      `
        insert into social_comments (
          post_id,
          parent_comment_id,
          author_type,
          author_wallet,
          user_profile_account,
          organization_account
        )
        values ($1, $2, $3, $4, $5, $6)
        returning *
      `,
      [
        id,
        parsed.parentCommentId ?? null,
        parsed.authorType,
        parsed.authorWallet,
        parsed.userProfileAccount ?? null,
        parsed.organizationAccount ?? null
      ]
    );
    const comment = commentResult.rows[0];

    const versionResult = await client.query(
      `
        insert into social_comment_versions (
          comment_id,
          version_number,
          content_json,
          canonical_json,
          content_hash,
          author_trust_snapshot
        )
        values ($1, 1, $2, $3, $4, $5)
        returning *
      `,
      [comment.id, parsed.content, canonical, hash, parsed.authorTrustSnapshot]
    );
    const version = versionResult.rows[0];

    const updatedCommentResult = await client.query(
      `
        update social_comments
        set current_version_id = $2,
            updated_at = now()
        where id = $1
        returning *
      `,
      [comment.id, version.id]
    );

    await client.query("commit");
    response.status(201).json({ comment: updatedCommentResult.rows[0], version });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
});

socialRouter.post("/comments/:id/versions", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);
  const parsed = EditCommentSchema.parse(request.body);
  const { canonical, hash } = hashVersion({
    authorTrustSnapshot: parsed.authorTrustSnapshot,
    content: parsed.content,
    schema: "solchan.social-comment-version.v1"
  });

  const client = await pool.connect();
  try {
    await client.query("begin");

    const currentResult = await client.query(
      `
        select c.*, v.id as previous_version_id, v.version_number as previous_version_number
        from social_comments c
        join social_comment_versions v on v.id = c.current_version_id
        where c.id = $1
        for update
      `,
      [id]
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new HttpError(404, "Comment not found");
    }

    const versionResult = await client.query(
      `
        insert into social_comment_versions (
          comment_id,
          version_number,
          content_json,
          canonical_json,
          content_hash,
          previous_version_id,
          author_trust_snapshot,
          edit_reason
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        returning *
      `,
      [
        id,
        Number(current.previous_version_number) + 1,
        parsed.content,
        canonical,
        hash,
        current.previous_version_id,
        parsed.authorTrustSnapshot,
        parsed.editReason ?? null
      ]
    );
    const version = versionResult.rows[0];

    const commentResult = await client.query(
      `
        update social_comments
        set current_version_id = $2,
            updated_at = now()
        where id = $1
        returning *
      `,
      [id, version.id]
    );

    await client.query("commit");
    response.status(201).json({ comment: commentResult.rows[0], version });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
});

socialRouter.get("/posts/:id/verify", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);

  const result = await pool.query(
    `
      select v.*
      from social_posts p
      join social_post_versions v on v.id = p.current_version_id
      where p.id = $1
    `,
    [id]
  );
  const version = result.rows[0];
  if (!version) {
    throw new HttpError(404, "Post not found");
  }

  const { canonical, hash } = hashVersion({
    authorTrustSnapshot: version.author_trust_snapshot,
    content: version.content_json,
    contentKind: version.content_kind,
    schema: "solchan.social-post-version.v1"
  });

  response.json({
    contentHash: version.content_hash,
    canonicalJsonMatches: canonical === version.canonical_json,
    recalculatedHash: hash,
    verified: hash === version.content_hash && canonical === version.canonical_json,
    versionId: version.id
  });
});

socialRouter.get("/comments/:id/verify", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);

  const result = await pool.query(
    `
      select v.*
      from social_comments c
      join social_comment_versions v on v.id = c.current_version_id
      where c.id = $1
    `,
    [id]
  );
  const version = result.rows[0];
  if (!version) {
    throw new HttpError(404, "Comment not found");
  }

  const { canonical, hash } = hashVersion({
    authorTrustSnapshot: version.author_trust_snapshot,
    content: version.content_json,
    schema: "solchan.social-comment-version.v1"
  });

  response.json({
    canonicalJsonMatches: canonical === version.canonical_json,
    contentHash: version.content_hash,
    recalculatedHash: hash,
    verified: hash === version.content_hash && canonical === version.canonical_json,
    versionId: version.id
  });
});
