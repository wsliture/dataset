CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE datasets (
  id uuid PRIMARY KEY, name text NOT NULL, note text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE documents (
  id uuid PRIMARY KEY, dataset_id uuid NOT NULL REFERENCES datasets ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('source','test_requirement')),
  name text NOT NULL, normalized_name text NOT NULL, warnings jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (dataset_id,type,normalized_name)
);
CREATE TABLE slices (
  id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES documents ON DELETE CASCADE,
  section_id text NOT NULL, section_path text[] NOT NULL, position integer NOT NULL,
  source_ref text NOT NULL, kind text NOT NULL CHECK (kind IN ('paragraph','clause','table','table_row')),
  parent_id uuid, row_order integer, text text NOT NULL, version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  terms tsvector NOT NULL DEFAULT '', identifiers text[] NOT NULL DEFAULT '{}',
  embedding vector, embedding_model text, embedding_version integer,
  CHECK ((kind = 'table_row') = (parent_id IS NOT NULL AND row_order IS NOT NULL)),
  UNIQUE (document_id,id), UNIQUE (document_id,position), UNIQUE (parent_id,row_order),
  FOREIGN KEY (document_id,parent_id) REFERENCES slices(document_id,id) ON DELETE CASCADE
);
CREATE INDEX slices_terms ON slices USING gin(terms);
CREATE INDEX slices_identifiers ON slices USING gin(identifiers);
CREATE TABLE cases (
  id uuid PRIMARY KEY, dataset_id uuid NOT NULL REFERENCES datasets ON DELETE CASCADE,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','withdrawn')),
  version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cases_dataset_order ON cases(dataset_id,updated_at DESC,id);
CREATE TABLE case_slices (
  case_id uuid NOT NULL REFERENCES cases ON DELETE CASCADE, slice_id uuid NOT NULL REFERENCES slices ON DELETE NO ACTION,
  side text NOT NULL CHECK (side IN ('source','test_requirement')), position integer NOT NULL,
  PRIMARY KEY (case_id,slice_id), UNIQUE (case_id,side,position)
);
CREATE INDEX case_slices_reverse ON case_slices(slice_id,case_id);
CREATE TABLE case_revisions (
  case_id uuid NOT NULL REFERENCES cases ON DELETE CASCADE, version integer NOT NULL,
  input jsonb NOT NULL, status text NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (case_id,version)
);
CREATE TABLE case_revision_slices (
  case_id uuid NOT NULL, version integer NOT NULL, slice_id uuid NOT NULL REFERENCES slices ON DELETE NO ACTION,
  side text NOT NULL, position integer NOT NULL,
  PRIMARY KEY (case_id,version,slice_id),
  FOREIGN KEY (case_id,version) REFERENCES case_revisions ON DELETE CASCADE
);
CREATE INDEX revision_slices_reverse ON case_revision_slices(slice_id,case_id);
CREATE TABLE file_cleanup_jobs (
  id uuid PRIMARY KEY, attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now()
);
CREATE VIEW eligible_cases AS
SELECT c.* FROM cases c JOIN datasets d ON d.id=c.dataset_id
WHERE c.status='published' AND d.status='active'
  AND EXISTS (SELECT FROM case_slices r WHERE r.case_id=c.id AND r.side='source')
  AND EXISTS (SELECT FROM case_slices r WHERE r.case_id=c.id AND r.side='test_requirement')
  AND NOT EXISTS (
    SELECT FROM case_slices r JOIN slices s ON s.id=r.slice_id JOIN documents doc ON doc.id=s.document_id
    WHERE r.case_id=c.id AND (doc.dataset_id<>c.dataset_id OR doc.type<>r.side)
  );
