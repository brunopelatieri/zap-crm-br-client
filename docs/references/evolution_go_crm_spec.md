# Evolution Go API - User & CRM Integration Reference

**Target LLM:** Opus 5
**Project Context:** The goal of this project is to use an unofficial WhatsApp connection (Evolution Go) to:
1. Check if a contact from a CRM system list (zap crm br) has a valid WhatsApp number to receive messages.
2. Retrieve the contacts related to the unofficial connection instance.
3. Fetch the avatar image, phone number, name, and contact data.
4. Store this collected data into the database.

Below is the API reference for the endpoints required to build the technical specification (SPEC) for this integration.

---

## 1. Check a User
**Reference Name API:** `Check a user`
**Description:** Verifies if one or more phone numbers possess a valid, active WhatsApp account.

### cURL Code
```bash
curl --request POST \
  --url http://localhost:8080/user/check \
  --header 'Content-Type: application/json' \
  --data '{
  "number": [
    "5511999999999"
  ]
}'
```

### Response Example
```json
{
  "data": {
    "Users": [
      {
        "Query": "+5511999999999@s.whatsapp.net",
        "IsInWhatsapp": true,
        "JID": "5511999999999@s.whatsapp.net",
        "RemoteJID": "5511999999999@s.whatsapp.net",
        "LID": "10000000000003@lid",
        "VerifiedName": ""
      }
    ]
  },
  "message": "success"
}
```

---

## 2. Get a User's Avatar
**Reference Name API:** `Get a user's avatar`
**Description:** Retrieves the profile picture (avatar) in base64 format for a specific WhatsApp number.

### cURL Code
```bash
curl --request POST \
  --url http://localhost:8080/user/avatar \
  --header 'Content-Type: application/json' \
  --data '{
  "number": "5511999999999",
  "preview": true
}'
```

### Response Example
```json
{
  "success": true,
  "avatar": "iVBORw0KGgoAAAANSUhEUgAA..."
}
```

---

## 3. Get a User's Contacts
**Reference Name API:** `Get a user's contacts`
**Description:** Retrieves the list of contacts related to the connected unofficial instance.

### cURL Code
```bash
curl --request GET \
  --url http://localhost:8080/user/contacts
```

### Response Example
```json
{
  "data": [
    {
      "Jid": "5511999999999@s.whatsapp.net",
      "Found": true,
      "FirstName": "",
      "FullName": "",
      "PushName": "Contact Name",
      "BusinessName": ""
    }
  ],
  "message": "success"
}
```

---

## 4. Get a User
**Reference Name API:** `Get a user`
**Description:** Retrieves specific data and status from a provided list of WhatsApp numbers.

### cURL Code
```bash
curl --request POST \
  --url http://localhost:8080/user/info \
  --header 'Content-Type: application/json' \
  --data '{
  "number": [
    "5511999999999"
  ]
}'
```

### Response Example
```json
{
  "data": {
    "Users": {
      "5511999999999@s.whatsapp.net": {
        "VerifiedName": null,
        "Status": " ",
        "PictureID": "123456789",
        "Devices": [
          "5511999999999@s.whatsapp.net"
        ],
        "LID": "10000000000004@lid"
      }
    }
  },
  "message": "success"
}
```
