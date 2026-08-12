create table user_endorsement_evidence_packages (
  id uuid primary key default gen_random_uuid(),
  endorsement_request_pda text not null,
  user_profile_account text not null,
  organization_pda text not null,
  requested_user_type text not null,
  requested_endorsement_kind text not null,
  context_hash text not null,
  criteria_bundle_hash text not null,
  evidence_text text not null default '',
  manifest_json jsonb not null,
  manifest_hash text not null unique,
  manifest_storage_path text not null unique,
  uploaded_by_wallet text not null,
  created_at timestamptz not null default now()
);

create index user_endorsement_evidence_packages_request_idx
  on user_endorsement_evidence_packages (endorsement_request_pda);

create index user_endorsement_evidence_packages_user_profile_idx
  on user_endorsement_evidence_packages (user_profile_account);

create index user_endorsement_evidence_packages_organization_idx
  on user_endorsement_evidence_packages (organization_pda);

create table user_endorsement_evidence_documents (
  id uuid primary key default gen_random_uuid(),
  evidence_package_id uuid not null references user_endorsement_evidence_packages (id) on delete cascade,
  original_filename text not null,
  stored_filename text not null,
  storage_path text not null unique,
  mime_type text not null,
  byte_size bigint not null,
  sha256_hash text not null,
  uploaded_by_wallet text not null,
  created_at timestamptz not null default now()
);

create index user_endorsement_evidence_documents_package_idx
  on user_endorsement_evidence_documents (evidence_package_id);
