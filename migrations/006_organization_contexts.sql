create table organization_contexts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations_offchain (id) on delete cascade,
  context_key text not null,
  title text not null,
  description text,
  metadata_json jsonb not null default '{}'::jsonb,
  context_hash text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, context_key)
);

create index organization_contexts_organization_id_idx
  on organization_contexts (organization_id);

insert into organization_contexts (
  organization_id,
  context_key,
  title,
  description,
  metadata_json,
  context_hash
)
select
  o.id,
  seed.context_key,
  seed.title,
  seed.description,
  jsonb_build_object(
    'schema', 'solchan.organization-context.v1',
    'source', 'migration-default',
    'organization', o.name
  ),
  encode(digest(o.id::text || ':' || seed.context_key, 'sha256'), 'hex')
from organizations_offchain o
cross join (
  values
    ('membership', 'Membership or participation', 'The user asks the organization to confirm membership, participation, or community relationship.'),
    ('course-completion', 'Course completion', 'The user asks the organization to confirm completion of a course, cohort, bootcamp, or learning track.'),
    ('event-attendance', 'Event attendance', 'The user asks the organization to confirm attendance or participation in a specific event.')
) as seed(context_key, title, description)
where o.organization_pda is not null
on conflict (organization_id, context_key) do nothing;
