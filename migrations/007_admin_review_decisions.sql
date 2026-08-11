alter table accreditation_requests_offchain
  add column if not exists decision_record_pda text,
  add column if not exists review_onchain_signature text,
  add column if not exists reviewed_by_wallet text;

create unique index if not exists accreditation_requests_decision_record_pda_idx
  on accreditation_requests_offchain (decision_record_pda)
  where decision_record_pda is not null;
