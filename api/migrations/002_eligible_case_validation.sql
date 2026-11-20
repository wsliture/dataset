CREATE OR REPLACE VIEW eligible_cases AS
SELECT c.* FROM cases c JOIN datasets d ON d.id=c.dataset_id
WHERE c.status='published' AND d.status='active'
  AND btrim(c.input->>'title') <> '' AND btrim(c.input->>'testObject') <> ''
  AND jsonb_array_length(c.input->'categories') > 0
  AND EXISTS (SELECT FROM case_slices r WHERE r.case_id=c.id AND r.side='source')
  AND EXISTS (SELECT FROM case_slices r WHERE r.case_id=c.id AND r.side='test_requirement')
  AND NOT EXISTS (
    SELECT FROM case_slices r JOIN slices s ON s.id=r.slice_id JOIN documents doc ON doc.id=s.document_id
    WHERE r.case_id=c.id AND (doc.dataset_id<>c.dataset_id OR doc.type<>r.side OR EXISTS (
      SELECT FROM case_slices parent WHERE parent.case_id=c.id AND parent.slice_id=s.parent_id
    ))
  );
