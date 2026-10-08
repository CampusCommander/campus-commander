-- Restored credentials require operator key verification and current provider evidence.
CREATE TABLE cc.google_restore_gate (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  recovery_id uuid NOT NULL,
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  credential_id uuid NOT NULL,
  generation integer NOT NULL CHECK(generation>0),
  restored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_at timestamptz
);
REVOKE ALL ON cc.google_restore_gate FROM PUBLIC;

CREATE OR REPLACE FUNCTION cc.google_current_generation(p_customer text,p_generation integer) RETURNS cc.google_connection
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  connection:=cc.google_bound_generation(p_customer,p_generation);
  IF NOT connection.active THEN
    RAISE EXCEPTION 'Background Google access is disconnected.' USING DETAIL='connection-disconnected';
  END IF;
  IF EXISTS(SELECT 1 FROM cc.google_restore_gate WHERE singleton AND verified_at IS NULL) THEN
    RAISE EXCEPTION 'Restored Google access requires revalidation.' USING DETAIL='restore-revalidation-required';
  END IF;
  RETURN connection;
END;
$$;

CREATE OR REPLACE FUNCTION cc.school_reference_projection() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('customerId',c.customer_id,'generation',c.generation,
    'observation',r.observation,'failure',r.failure,'checkedAt',r.checked_at,
    'fresh',COALESCE(c.active AND r.failure IS NULL AND r.observation->>'generation'=c.generation::text
      AND r.observed_at>clock_timestamp()-interval '10 minutes'
      AND (g.recovery_id IS NULL OR (g.verified_at IS NOT NULL AND r.observed_at>g.restored_at)),false),
    'checking',COALESCE(r.lease_id IS NOT NULL AND r.lease_generation=c.generation
      AND r.lease_expires_at>clock_timestamp(),false),'retryAt',r.retry_at)
  FROM cc.google_connection c
  LEFT JOIN cc.school_reference_state r ON r.customer_id=c.customer_id
  LEFT JOIN cc.google_restore_gate g ON g.customer_id=c.customer_id;
$$;
