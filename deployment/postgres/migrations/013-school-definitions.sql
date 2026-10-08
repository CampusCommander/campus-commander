-- Saved school definitions retain explicit approval independently of reference health.
CREATE FUNCTION cc.school_rule_ids(p_rules jsonb,p_units jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,cc AS $$
DECLARE rule jsonb; rule_ids text[]:=ARRAY[]::text[]; result jsonb;
BEGIN
  IF p_rules IS NULL OR jsonb_typeof(p_rules)<>'object' OR p_rules-ARRAY['include','exclude']<>'{}'::jsonb OR
    jsonb_typeof(p_rules->'include') IS DISTINCT FROM 'array' OR jsonb_typeof(p_rules->'exclude') IS DISTINCT FROM 'array' OR
    NOT cc.school_reference_units_valid(p_units) THEN RETURN NULL; END IF;
  IF jsonb_array_length(p_rules->'include') NOT BETWEEN 1 AND 128 OR jsonb_array_length(p_rules->'exclude')>128 THEN RETURN NULL; END IF;
  FOR rule IN SELECT * FROM jsonb_array_elements((p_rules->'include')||(p_rules->'exclude')) LOOP
    IF jsonb_typeof(rule)<>'object' OR rule-ARRAY['id','descendants']<>'{}'::jsonb OR
      jsonb_typeof(rule->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(rule->'descendants') IS DISTINCT FROM 'boolean' OR
      rule->>'id'=ANY(rule_ids) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_units) u WHERE u->>'id'=rule->>'id') THEN RETURN NULL; END IF;
    rule_ids:=array_append(rule_ids,rule->>'id');
  END LOOP;
  WITH RECURSIVE ancestry(id,ancestor) AS (
    SELECT u->>'id',u->>'id' FROM jsonb_array_elements(p_units) u
    UNION ALL
    SELECT a.id,u->>'parentId' FROM ancestry a JOIN jsonb_array_elements(p_units) u ON u->>'id'=a.ancestor
      WHERE u->>'parentId' IS NOT NULL
  ) SELECT jsonb_agg(u->>'id' ORDER BY u->>'id') INTO result FROM jsonb_array_elements(p_units) u
    WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(p_rules->'include') r WHERE r->>'id'=u->>'id' OR
      ((r->>'descendants')::boolean AND EXISTS(SELECT 1 FROM ancestry a WHERE a.id=u->>'id' AND a.ancestor=r->>'id')))
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_rules->'exclude') r WHERE r->>'id'=u->>'id' OR
      ((r->>'descendants')::boolean AND EXISTS(SELECT 1 FROM ancestry a WHERE a.id=u->>'id' AND a.ancestor=r->>'id')));
  RETURN result;
END;
$$;

CREATE TABLE cc.school_definitions (
  id uuid PRIMARY KEY,
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 256 AND length(btrim(name))>0 AND name !~ '[[:cntrl:]]'),
  revision integer NOT NULL CHECK(revision>0),
  rules jsonb NOT NULL,
  approved_ids jsonb NOT NULL CHECK(jsonb_typeof(approved_ids)='array' AND jsonb_array_length(approved_ids) BETWEEN 1 AND 10000),
  reference_revision uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(id,customer_id)
);
CREATE TABLE cc.school_reviews (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES cc.application_principals(id),
  actor_version integer NOT NULL,
  school_id uuid NOT NULL,
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  expected_revision integer NOT NULL CHECK(expected_revision>=0),
  reference_revision uuid NOT NULL,
  name text NOT NULL,
  rules jsonb NOT NULL,
  approved_ids jsonb NOT NULL,
  affected_principals jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  applied_at timestamptz,
  correlation_id uuid NOT NULL
);

CREATE FUNCTION cc.school_actor(p_actor uuid,p_version integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(7240173008);
  PERFORM 1 FROM cc.application_principals WHERE id=p_actor AND enabled AND permission_version=p_version FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current school authority is required.' USING ERRCODE='42501'; END IF;
END;
$$;
CREATE FUNCTION cc.school_allowed(p_actor uuid,p_school uuid,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT EXISTS(SELECT 1 FROM cc.school_definitions s JOIN cc.application_grants g ON g.principal_id=p_actor AND g.action=p_action
    WHERE s.id=p_school AND (g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'customerId'=s.customer_id AND (g.scope->>'kind'='district' OR
        (g.scope->>'kind'='school' AND g.scope->>'schoolId'=s.id::text)))));
$$;
CREATE FUNCTION cc.school_effective_ids(p_school uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE school cc.school_definitions; references_state jsonb; resolved jsonb; result jsonb;
BEGIN
  SELECT * INTO school FROM cc.school_definitions WHERE id=p_school;
  IF school.id IS NULL THEN RETURN NULL; END IF;
  references_state:=cc.school_reference_projection();
  IF references_state->>'customerId' IS DISTINCT FROM school.customer_id OR references_state->'fresh' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL; END IF;
  resolved:=cc.school_rule_ids(school.rules,references_state->'observation'->'units');
  IF resolved IS NULL THEN RETURN NULL; END IF;
  SELECT jsonb_agg(id ORDER BY id) INTO result FROM jsonb_array_elements_text(resolved) id WHERE school.approved_ids ? id;
  RETURN result;
END;
$$;
CREATE FUNCTION cc.school_definition(p_school uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('id',id,'customerId',customer_id,'name',name,'revision',revision,'rules',rules,
    'approvedIds',approved_ids,'effectiveIds',cc.school_effective_ids(id),'referenceRevision',reference_revision,'updatedAt',updated_at)
    FROM cc.school_definitions WHERE id=p_school;
$$;
CREATE FUNCTION cc.read_school_definition(p_actor uuid,p_version integer,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  PERFORM cc.school_actor(p_actor,p_version);
  IF NOT cc.school_allowed(p_actor,p_school,'schools:read') THEN RETURN NULL; END IF;
  RETURN cc.school_definition(p_school);
END;
$$;
CREATE FUNCTION cc.list_school_definitions(p_actor uuid,p_version integer,p_offset integer,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE result jsonb;
BEGIN
  PERFORM cc.school_actor(p_actor,p_version);
  IF p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'The requested page is invalid.' USING ERRCODE='22023'; END IF;
  SELECT jsonb_build_object('total',(SELECT count(*) FROM cc.school_definitions WHERE cc.school_allowed(p_actor,id,'schools:read')),
    'offset',p_offset,'limit',p_limit,'items',COALESCE(jsonb_agg(cc.school_definition(id) ORDER BY id),'[]'::jsonb)) INTO result
    FROM (SELECT id FROM cc.school_definitions WHERE cc.school_allowed(p_actor,id,'schools:read') ORDER BY id OFFSET p_offset LIMIT p_limit) page;
  RETURN result;
END;
$$;
CREATE FUNCTION cc.school_affected_principals(p_school uuid,p_customer text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'version',p.permission_version,
    'invitationIds',COALESCE((SELECT jsonb_agg(i.id ORDER BY i.id) FROM cc.application_invitations i
      WHERE i.created_by=p.id AND i.status IN ('issued','redeeming','pending')),'[]'::jsonb)) ORDER BY p.id),'[]'::jsonb)
    FROM cc.application_principals p WHERE EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p.id
      AND g.scope=jsonb_build_object('kind','school','customerId',p_customer,'schoolId',p_school));
$$;
CREATE FUNCTION cc.school_review_result(p_review uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('id',id,'schoolId',school_id,'customerId',customer_id,'expectedRevision',expected_revision,
    'referenceRevision',reference_revision,'name',name,'rules',rules,'approvedIds',approved_ids,
    'affectedPrincipalCount',jsonb_array_length(affected_principals),
    'invitationIds',COALESCE((SELECT jsonb_agg(invitation ORDER BY invitation) FROM jsonb_array_elements(affected_principals) p
      CROSS JOIN LATERAL jsonb_array_elements(p->'invitationIds') invitation),'[]'::jsonb),
    'expiresAt',expires_at,'appliedAt',applied_at,
    'revision',CASE WHEN applied_at IS NULL THEN NULL ELSE expected_revision+1 END)
    FROM cc.school_reviews WHERE id=p_review;
$$;
CREATE FUNCTION cc.preview_school_definition(p_actor uuid,p_version integer,p_school uuid,p_customer text,p_expected integer,
  p_reference uuid,p_name text,p_rules jsonb,p_review uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE current_school cc.school_definitions; references_state jsonb; approved jsonb; observed timestamptz:=clock_timestamp();
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'schools:manage');
  SELECT * INTO current_school FROM cc.school_definitions WHERE id=p_school;
  IF p_school IS NULL OR p_review IS NULL OR p_correlation IS NULL OR p_expected IS NULL OR p_expected NOT BETWEEN 0 AND 2147483646 OR
    p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 256 OR length(btrim(p_name))=0 OR p_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'The school definition is invalid.' USING ERRCODE='22023'; END IF;
  IF current_school.id IS NOT NULL AND current_school.customer_id IS DISTINCT FROM p_customer THEN
    RAISE EXCEPTION 'The school customer changed.' USING ERRCODE='42501'; END IF;
  IF COALESCE(current_school.revision,0)<>p_expected THEN
    RAISE EXCEPTION 'The school definition changed.' USING DETAIL='school-changed'; END IF;
  references_state:=cc.school_reference_projection();
  IF references_state IS NULL OR references_state->>'customerId' IS DISTINCT FROM p_customer OR
    references_state->'fresh' IS DISTINCT FROM 'true'::jsonb OR
    references_state->'observation'->>'revision' IS DISTINCT FROM p_reference::text THEN
    RAISE EXCEPTION 'Refresh the school references.' USING DETAIL='references-changed'; END IF;
  approved:=cc.school_rule_ids(p_rules,references_state->'observation'->'units');
  IF approved IS NULL THEN RAISE EXCEPTION 'The scope rules do not resolve a school.' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM cc.school_reviews WHERE actor_id=p_actor AND applied_at IS NULL AND expires_at>observed)>=20 THEN
    RAISE EXCEPTION 'Too many school reviews are pending.' USING DETAIL='school-review-limit'; END IF;
  INSERT INTO cc.school_reviews(id,actor_id,actor_version,school_id,customer_id,expected_revision,reference_revision,name,rules,
    approved_ids,affected_principals,created_at,expires_at,correlation_id)
    VALUES(p_review,p_actor,p_version,p_school,p_customer,p_expected,p_reference,p_name,p_rules,approved,
      cc.school_affected_principals(p_school,p_customer),observed,observed+interval '10 minutes',p_correlation);
  RETURN cc.school_review_result(p_review);
END;
$$;
CREATE FUNCTION cc.confirm_school_definition(p_actor uuid,p_version integer,p_review uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE review cc.school_reviews; references_state jsonb; affected jsonb; changed_id uuid; observed timestamptz;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'schools:manage');
  SELECT * INTO review FROM cc.school_reviews WHERE id=p_review FOR UPDATE;
  IF review.id IS NULL OR review.actor_id<>p_actor THEN
    RAISE EXCEPTION 'The school review is unavailable.' USING ERRCODE='42501'; END IF;
  IF review.applied_at IS NOT NULL THEN RETURN cc.school_review_result(p_review); END IF;
  observed:=clock_timestamp();
  IF review.actor_version<>p_version OR review.expires_at<=observed OR
    COALESCE((SELECT revision FROM cc.school_definitions WHERE id=review.school_id),0)<>review.expected_revision THEN
    RAISE EXCEPTION 'Review the current school definition.' USING DETAIL='school-changed'; END IF;
  references_state:=cc.school_reference_projection();
  IF references_state->'fresh' IS DISTINCT FROM 'true'::jsonb OR references_state->>'customerId' IS DISTINCT FROM review.customer_id OR
    references_state->'observation'->>'revision' IS DISTINCT FROM review.reference_revision::text THEN
    RAISE EXCEPTION 'Refresh the school references.' USING DETAIL='references-changed'; END IF;
  affected:=cc.school_affected_principals(review.school_id,review.customer_id);
  IF affected<>review.affected_principals THEN
    RAISE EXCEPTION 'School access changed. Review the definition again.' USING DETAIL='school-access-changed'; END IF;
  INSERT INTO cc.school_definitions(id,customer_id,name,revision,rules,approved_ids,reference_revision,updated_at)
    VALUES(review.school_id,review.customer_id,review.name,review.expected_revision+1,review.rules,review.approved_ids,review.reference_revision,observed)
    ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,revision=EXCLUDED.revision,rules=EXCLUDED.rules,
      approved_ids=EXCLUDED.approved_ids,reference_revision=EXCLUDED.reference_revision,updated_at=EXCLUDED.updated_at;
  FOR changed_id IN SELECT (p->>'id')::uuid FROM jsonb_array_elements(affected) p LOOP
    PERFORM cc.revoke_principal_invitations(changed_id,p_actor,review.correlation_id);
    UPDATE cc.application_principals SET permission_version=permission_version+1 WHERE id=changed_id;
  END LOOP;
  UPDATE cc.school_reviews SET applied_at=observed WHERE id=p_review;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope,detail)
    VALUES(gen_random_uuid(),p_actor,'school-scope-changed',review.correlation_id,review.school_id,
      jsonb_build_object('kind','school','customerId',review.customer_id,'schoolId',review.school_id),
      'revision:'||(review.expected_revision+1)::text);
  RETURN cc.school_review_result(p_review);
END;
$$;
CREATE FUNCTION cc.read_school_review(p_actor uuid,p_version integer,p_review uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'schools:manage');
  IF NOT EXISTS(SELECT 1 FROM cc.school_reviews WHERE id=p_review AND actor_id=p_actor) THEN RETURN NULL; END IF;
  RETURN cc.school_review_result(p_review);
END;
$$;
CREATE FUNCTION cc.list_school_audit(p_actor uuid,p_version integer,p_school uuid,p_offset integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE result jsonb;
BEGIN
  PERFORM cc.school_actor(p_actor,p_version);
  IF NOT cc.school_allowed(p_actor,p_school,'schools:read') OR NOT cc.school_allowed(p_actor,p_school,'security-events:read') THEN RETURN NULL; END IF;
  IF p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 THEN RAISE EXCEPTION 'The requested page is invalid.' USING ERRCODE='22023'; END IF;
  SELECT jsonb_build_object('total',(SELECT count(*) FROM cc.security_events WHERE resource_scope->>'kind'='school' AND resource_scope->>'schoolId'=p_school::text),
    'offset',p_offset,'items',COALESCE(jsonb_agg(jsonb_build_object('id',id,'event',event,'detail',detail,'occurredAt',occurred_at,'correlationId',correlation_id) ORDER BY occurred_at DESC,id),'[]'::jsonb)) INTO result
    FROM (SELECT * FROM cc.security_events WHERE resource_scope->>'kind'='school' AND resource_scope->>'schoolId'=p_school::text ORDER BY occurred_at DESC,id OFFSET p_offset LIMIT 20) page;
  RETURN result;
END;
$$;
REVOKE ALL ON cc.school_definitions,cc.school_reviews FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.school_rule_ids(jsonb,jsonb),cc.school_actor(uuid,integer),cc.school_allowed(uuid,uuid,text),
  cc.school_effective_ids(uuid),cc.school_definition(uuid),cc.read_school_definition(uuid,integer,uuid),
  cc.list_school_definitions(uuid,integer,integer,integer),cc.school_affected_principals(uuid,text),cc.school_review_result(uuid),
  cc.preview_school_definition(uuid,integer,uuid,text,integer,uuid,text,jsonb,uuid,uuid),
  cc.confirm_school_definition(uuid,integer,uuid),cc.read_school_review(uuid,integer,uuid),cc.list_school_audit(uuid,integer,uuid,integer) FROM PUBLIC;
