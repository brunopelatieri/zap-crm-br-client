# Webhook WhatsApp Meta Cloud API version 27

## Messages

```
{
  "field": "messages",
  "value": {
    "messaging_product": "whatsapp",
    "metadata": {
      "display_phone_number": "16505551111",
      "phone_number_id": "123456123"
    },
    "contacts": [
      {
        "profile": {
          "name": "test user name"
        },
        "wa_id": "16315551181",
        "user_id": "US.13491208655302741918"
      }
    ],
    "messages": [
      {
        "id": "ABGGFlA5Fpa",
        "timestamp": "1504902988",
        "from": "16315551181",
        "from_user_id": "US.13491208655302741918",
        "type": "text",
        "text": {
          "body": "this is a text message"
        }
      }
    ]
  }
}

```
---

## message_template_status_update

```
{
  "sample": {
    "field": "message_template_status_update",
    "value": {
      "event": "APPROVED",
      "message_template_id": 12345678,
      "message_template_name": "my_message_template",
      "message_template_language": "pt-BR",
      "reason": null,
      "message_template_category": "MARKETING"
    }
  },
  "sub_field_options": null,
  "sample_context_metadata": null
}

```
---

## message_template_quality_update

```
{
  "sample": {
    "field": "message_template_quality_update",
    "value": {
      "previous_quality_score": "GREEN",
      "new_quality_score": "YELLOW",
      "message_template_id": 12345678,
      "message_template_name": "my_message_template",
      "message_template_language": "pt-BR"
    }
  },
  "sub_field_options": null,
  "sample_context_metadata": null
}

```
---

## phone_number_name_update

```
{
  "sample": {
    "field": "phone_number_name_update",
    "value": {
      "display_phone_number": "16505551111",
      "decision": "APPROVED",
      "requested_verified_name": "WhatsApp",
      "rejection_reason": null
    }
  },
  "sub_field_options": null,
  "sample_context_metadata": null
}

```
---

## phone_number_quality_update

```
{
  "sample": {
    "field": "phone_number_quality_update",
    "value": {
      "display_phone_number": "16505551111",
      "event": "ONBOARDING",
      "current_limit": "TIER_250",
      "old_limit": "TIER_NOT_SET",
      "max_daily_conversations_per_business": "TIER_250"
    }
  },
  "sub_field_options": null,
  "sample_context_metadata": null
}

```
---

## security

```
{
  "sample": {
    "field": "security",
    "value": {
      "display_phone_number": "16505551111",
      "event": "PIN_CHANGED",
      "requester": "1000"
    }
  },
  "sub_field_options": null,
  "sample_context_metadata": null
}

```
---

## calls

```
{
  "sample": {
    "field": "calls",
    "value": {
      "messaging_product": "whatsapp",
      "metadata": {
        "display_phone_number": "16505551111",
        "phone_number_id": "123456123"
      },
      "calls": [
        {
          "id": "ABGGFlA5Fpa",
          "to": "18005551180",
          "from": "16315551181",
          "timestamp": 1504902988,
          "event": "connect"
        }
      ],
      "contacts": [
        {
          "profile": {
            "name": "test user name"
          },
          "wa_id": "16315551181"
        }
      ]
    }
  },
  "sub_field_options": null,
  "sample_context_metadata": null
}

```
---

## account_update

```
{
  "sample": {
    "field": "account_update",
    "value": {
      "phone_number": "16505551111",
      "event": "VERIFIED_ACCOUNT"
    }
  },
  "sub_field_options": null,
  "sample_context_metadata": null
}

```
---

## account_review_update

```
{
  "sample": {
    "field": "account_review_update",
    "value": {
      "decision": "APPROVED"
    }
  },
  "sub_field_options": null,
  "sample_context_metadata": null
}

```
---

## account_alerts

```
{
  "sample": {
    "field": "account_alerts",
    "value": {
      "entity_type": "WABA",
      "entity_id": 123456,
      "alert_severity": "INFORMATIONAL",
      "alert_status": "NONE",
      "alert_type": "OBA_APPROVED",
      "alert_description": "Sample alert description, informational in nature with no status"
    }
  },
  "sub_field_options": null,
  "sample_context_metadata": null
}

```
---