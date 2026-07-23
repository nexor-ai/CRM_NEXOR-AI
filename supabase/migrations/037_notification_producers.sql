-- Semantic producers for the contextual notification MVP.
-- They emit only terminal/important transitions and never per-message noise.

CREATE OR REPLACE FUNCTION notify_automation_failure()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'failed' THEN
    PERFORM create_contextual_notification(
      NEW.account_id, NEW.user_id, 'automation.failed', 'automation', 'error',
      'Automação falhou', COALESCE(NEW.error_message, 'A execução terminou com erro.'),
      '/automations/' || NEW.automation_id || '/logs', 'automation', NEW.automation_id,
      'automation:' || NEW.automation_id || ':failed:' || date_trunc('hour', NEW.created_at)::text,
      jsonb_build_object('log_id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS automation_failure_notification ON automation_logs;
CREATE TRIGGER automation_failure_notification
AFTER INSERT ON automation_logs FOR EACH ROW EXECUTE FUNCTION notify_automation_failure();

CREATE OR REPLACE FUNCTION notify_flow_terminal_event()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_title TEXT; v_severity TEXT;
BEGIN
  IF NEW.status NOT IN ('handed_off','timed_out','failed')
     OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  v_title := CASE NEW.status
    WHEN 'handed_off' THEN 'Flow encaminhou conversa para atendimento humano'
    WHEN 'timed_out' THEN 'Flow expirou aguardando resposta'
    ELSE 'Flow terminou com erro' END;
  v_severity := CASE WHEN NEW.status = 'failed' THEN 'error' ELSE 'warning' END;
  PERFORM create_contextual_notification(
    NEW.account_id, NEW.user_id, 'flow.' || NEW.status, 'flow', v_severity,
    v_title, NEW.end_reason,
    CASE WHEN NEW.conversation_id IS NOT NULL
      THEN '/inbox?c=' || NEW.conversation_id ELSE '/flows/' || NEW.flow_id || '/runs' END,
    'flow_run', NEW.id, 'flow-run:' || NEW.id || ':' || NEW.status,
    jsonb_build_object('flow_id', NEW.flow_id, 'conversation_id', NEW.conversation_id)
  );
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS flow_terminal_notification ON flow_runs;
CREATE TRIGGER flow_terminal_notification
AFTER UPDATE OF status ON flow_runs FOR EACH ROW EXECUTE FUNCTION notify_flow_terminal_event();

CREATE OR REPLACE FUNCTION notify_deal_semantic_transition()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('won','lost') AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM create_contextual_notification(
      NEW.account_id, COALESCE(NEW.assigned_to, NEW.user_id),
      'pipeline.deal_' || NEW.status, 'pipeline',
      CASE WHEN NEW.status = 'won' THEN 'info' ELSE 'warning' END,
      CASE WHEN NEW.status = 'won' THEN 'Negócio ganho' ELSE 'Negócio perdido' END,
      NEW.title, '/pipelines', 'deal', NEW.id,
      'deal:' || NEW.id || ':' || NEW.status,
      jsonb_build_object('value', NEW.value, 'currency', NEW.currency)
    );
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS deal_semantic_notification ON deals;
CREATE TRIGGER deal_semantic_notification
AFTER UPDATE OF status ON deals FOR EACH ROW EXECUTE FUNCTION notify_deal_semantic_transition();

CREATE OR REPLACE FUNCTION notify_webhook_auto_disabled()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_recipient UUID;
BEGIN
  IF OLD.is_active = true AND NEW.is_active = false AND NEW.failure_count >= 15 THEN
    SELECT COALESCE(NEW.created_by, a.owner_user_id) INTO v_recipient
    FROM accounts a WHERE a.id = NEW.account_id;
    IF v_recipient IS NOT NULL THEN
      PERFORM create_contextual_notification(
        NEW.account_id, v_recipient, 'integration.webhook_disabled',
        'integration', 'critical', 'Webhook externo desativado automaticamente',
        'O endpoint acumulou 15 falhas consecutivas e foi bloqueado por segurança.',
        '/settings?tab=api', 'webhook_endpoint', NEW.id,
        'webhook:' || NEW.id || ':disabled',
        jsonb_build_object('failure_count', NEW.failure_count)
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS webhook_auto_disabled_notification ON webhook_endpoints;
CREATE TRIGGER webhook_auto_disabled_notification
AFTER UPDATE OF is_active, failure_count ON webhook_endpoints
FOR EACH ROW EXECUTE FUNCTION notify_webhook_auto_disabled();

CREATE OR REPLACE FUNCTION notify_whatsapp_disconnected()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.status = 'connected' AND NEW.status = 'disconnected' THEN
    PERFORM create_contextual_notification(
      NEW.account_id, NEW.user_id, 'integration.whatsapp_disconnected',
      'integration', 'critical', 'WhatsApp desconectado',
      'A instância da Evolution deixou de responder como conectada.',
      '/settings?tab=whatsapp', 'whatsapp_config', NEW.id,
      'whatsapp:' || NEW.id || ':disconnected',
      jsonb_build_object('connection_state', NEW.connection_state)
    );
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS whatsapp_disconnected_notification ON whatsapp_config;
CREATE TRIGGER whatsapp_disconnected_notification
AFTER UPDATE OF status ON whatsapp_config
FOR EACH ROW EXECUTE FUNCTION notify_whatsapp_disconnected();
