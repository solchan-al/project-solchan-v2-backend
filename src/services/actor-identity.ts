import type { Pool, PoolClient } from "pg";

import { env } from "../config/env.js";
import { HttpError } from "../http/errors.js";

type Queryable = Pick<Pool | PoolClient, "query">;

type ActorType = "admin" | "organization" | "user";

type ActorRegistrationEntry = {
  actorRef: string;
  actorType: ActorType;
  label: string | null;
};

export type ActorRegistration =
  | { status: "unregistered"; walletAddress: string }
  | { status: "registered"; walletAddress: string; registration: ActorRegistrationEntry }
  | { status: "conflict"; walletAddress: string; registrations: ActorRegistrationEntry[] };

export async function getActorRegistration(
  client: Queryable,
  walletAddress: string
): Promise<ActorRegistration> {
  const registrations: ActorRegistrationEntry[] = [];

  if (env.SOLCHAN_ADMIN_WALLETS.includes(walletAddress)) {
    registrations.push({
      actorRef: walletAddress,
      actorType: "admin",
      label: "Protocol admin"
    });
  }

  const userResult = await client.query(
    `
      select distinct on (record_key)
        record_key,
        content_json
      from admin_metadata_documents
      where record_type = 'user'
        and record_kind = 'profile'
        and created_by_wallet = $1
      order by record_key, created_at desc
    `,
    [walletAddress]
  );

  for (const row of userResult.rows) {
    const content = row.content_json as Record<string, unknown>;
    registrations.push({
      actorRef: row.record_key,
      actorType: "user",
      label: stringValue(content.displayName)
    });
  }

  const organizationResult = await client.query(
    `
      select organization_pda, name
      from organizations_offchain
      where wallet_address = $1
      order by created_at asc
    `,
    [walletAddress]
  );

  for (const row of organizationResult.rows) {
    registrations.push({
      actorRef: row.organization_pda ?? row.name,
      actorType: "organization",
      label: row.name
    });
  }

  if (registrations.length === 0) {
    return { status: "unregistered", walletAddress };
  }

  if (registrations.length === 1) {
    return { status: "registered", walletAddress, registration: registrations[0] };
  }

  return { status: "conflict", walletAddress, registrations };
}

export async function assertWalletCanRegisterAs(
  client: Queryable,
  walletAddress: string,
  requestedType: Exclude<ActorType, "admin">
) {
  const registration = await getActorRegistration(client, walletAddress);

  if (registration.status === "unregistered") return;

  if (registration.status === "conflict") {
    throw new HttpError(
      409,
      "This wallet already has multiple identity records. Resolve the wallet identity conflict before creating another registration."
    );
  }

  const existingType = registration.registration.actorType;
  if (existingType === requestedType) {
    throw new HttpError(
      409,
      `This wallet is already registered as ${articleFor(existingType)} ${existingType}. Duplicate registration is not allowed.`
    );
  }

  throw new HttpError(
    409,
    `This wallet is already registered as ${articleFor(existingType)} ${existingType}. Use a different wallet to register as ${articleFor(requestedType)} ${requestedType}.`
  );
}

function articleFor(value: string) {
  return /^[aeiou]/i.test(value) ? "an" : "a";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
