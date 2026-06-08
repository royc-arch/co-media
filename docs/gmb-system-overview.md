# GMB Review Reply — System Overview

## User Journey

```mermaid
flowchart TD
    A([User]) --> B[Connect Google Account\nOAuth 2.0]
    B --> C[(Supabase\nTokens stored)]
    C --> D[Dashboard]

    D --> E[Sync from Google]
    E --> F{Compare\ncache vs Google}
    F -->|New reviews| G[Upsert to cache]
    F -->|Missing from Google| H[Mark removed_from_google]
    G --> D
    H --> D

    D --> I[Filter Reviews]
    I --> I1[By card:\nAll / Awaiting / Replied / Removed]
    I --> I2[By time:\nAll / 1M / 3M / 6M]
    I --> I3[By stars:\n1★ – 5★ multi-select]

    D --> J{Reply mode}
    J --> K[Single Reply]
    J --> L[Bulk Reply All]
```

---

## Single Reply Flow

```mermaid
flowchart TD
    K[Open review] --> K1[Select Saved Style\nauto-fills keywords + context]
    K1 --> K2[Generate Round 1\n5 AI variations]
    K2 --> K3{User picks\nbest one}
    K3 --> K4[Refine Round 2\n5 refined variations]
    K4 --> K5{User confirms}
    K5 --> K6[POST to Google API]
    K6 --> K7{Response}
    K7 -->|200 OK| K8[Mark replied in cache\nUpdate stats]
    K7 -->|404 Not Found| K9[Mark removed_from_google\nShow skipped]
```

---

## Bulk Reply Flow

```mermaid
flowchart TD
    L[Open Bulk Modal] --> L1[Configure filters\nTime · Count · Stars · Style\nSkip no-comment toggle]
    L1 --> L2[Generate All]
    L2 --> L3[Fetch unreplied reviews\nfrom cache]
    L3 --> L4[For each review:\ncall suggest-reply API]
    L4 --> L5[Confirm screen\neditable previews]
    L5 --> L6[Post All]
    L6 --> L7[For each item:\ncall reply API]
    L7 --> L8{Result}
    L8 -->|OK| L9[✓ Posted\nUpdate stats]
    L8 -->|404| L10[— Skipped\nMark removed]
    L8 -->|Error| L11[✗ Failed\nShow error]
    L9 & L10 & L11 --> L12[Done summary\nN posted · N skipped · N failed]
```

---

## AI Reply Quality Pipeline

```mermaid
flowchart LR
    P1[Review text\nauthor · stars] --> P2[Build prompt]
    P2 --> P3[Active style\nkeywords · context\ncampaign note]
    P2 --> P4[Recent 6 replies\ndiversity guard]
    P3 & P4 --> P5[GPT-4o\ntemp 0.9]
    P5 --> P6[stripTagQuestions\nregex filter]
    P6 --> P7[filterBannedWords\nthrilled → glad etc.]
    P7 --> P8[enforceLength\ncut at sentence boundary]
    P8 --> P9[5 reply candidates]
```

---

## Style Management Flow

```mermaid
flowchart TD
    S[Manage Styles page] --> S1[Create style\nwrite example replies]
    S1 --> S2[Set star rating\napply_mask bitmask]
    S2 --> S3[Add keywords\n2 fields · 25 chars each]
    S3 --> S4[Add context\nbackground only]
    S4 --> S5[Add campaign note\n+200 char bonus]
    S5 --> S6[Test Panel\npreview on real review]
    S6 --> S7{Satisfied?}
    S7 -->|Set Active| S8[Write to prompt_hints\nall future replies use this style]
    S7 -->|Adjust| S1
    S8 --> S9[Green badge ● Active\nclick to deactivate]
```

---

## Data Layer

```mermaid
erDiagram
    gmb_connections {
        uuid user_id
        text access_token
        text refresh_token
        timestamptz expires_at
    }
    gmb_settings {
        uuid user_id
        text location_name
        text display_name
        text prompt_hints
        text custom_instructions
    }
    gmb_reviews {
        text review_name
        text author
        text rating
        text comment
        bool replied
        text reply_text
        bool has_photo
        bool removed_from_google
    }
    gmb_styles {
        uuid user_id
        text location_name
        text name
        int stars
        int apply_mask
        text style_text
        text keywords
        text context
    }

    gmb_settings ||--o{ gmb_reviews : "location_name"
    gmb_settings ||--o{ gmb_styles  : "location_name"
    gmb_connections ||--|| gmb_settings : "user_id"
```
