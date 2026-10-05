-- "Web OR Meta" is two packages now (packages/catalog/src/plans.ts, "Seven
-- packages, five cards"): Web Chatbot / Meta Chatbot replace `chat-single`,
-- Web + Voice / Meta + Voice replace `chat-voice`, each with its own Stripe
-- product. The package id alone says which channels a clinic has, so the
-- `chat_channel_choice` column that sat beside it goes. It could only ever
-- disagree with the plan: a switch between the twins in Stripe's Customer
-- Portal changes the price and nothing else.
--
-- Rows written before the split are moved to the twin their choice meant,
-- web when none was recorded (the default it already applied), before the
-- column is dropped. The catalog no longer knows the old ids, so a row left on
-- one would be a clinic whose package resolves to nothing.
--
-- `entitlements` is FORCEd (0028), and FORCE applies the tenant policy to its
-- owner too, so a bare UPDATE from this migration would match no rows and
-- report success. Each clinic is therefore visited inside its own tenant
-- context, the way provisioning writes (0002). `clinics.plan`, the package as
-- sold, is moved in the same pass from the same choice.
DO $$
DECLARE
  c record;
  choice text;
BEGIN
  FOR c IN SELECT id FROM clinics LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    SELECT e.chat_channel_choice INTO choice FROM entitlements e WHERE e.clinic_id = c.id;

    UPDATE clinics SET plan = CASE plan
        WHEN 'chat-single' THEN CASE WHEN choice = 'meta' THEN 'chat-meta' ELSE 'chat-web' END
        WHEN 'chat-voice' THEN CASE WHEN choice = 'meta' THEN 'meta-voice' ELSE 'web-voice' END
      END
     WHERE id = c.id AND plan IN ('chat-single', 'chat-voice');

    UPDATE entitlements SET plan_code = CASE plan_code
        WHEN 'chat-single' THEN CASE WHEN choice = 'meta' THEN 'chat-meta' ELSE 'chat-web' END
        WHEN 'chat-voice' THEN CASE WHEN choice = 'meta' THEN 'meta-voice' ELSE 'web-voice' END
      END
     WHERE clinic_id = c.id AND plan_code IN ('chat-single', 'chat-voice');
  END LOOP;
  PERFORM set_config('app.clinic_id', '', true);
END $$;--> statement-breakpoint
ALTER TABLE "entitlements" DROP CONSTRAINT "entitlements_chat_choice_check";--> statement-breakpoint
ALTER TABLE "entitlements" DROP COLUMN "chat_channel_choice";
