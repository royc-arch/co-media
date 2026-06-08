# Co.Media — System Flows & Tool Calls

---

## 1. Photo Style Transfer

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant API as Next.js<br/>/api/transform
    participant Storage as Supabase<br/>Storage
    participant DB as Supabase<br/>DB
    participant GPT_mini as GPT-4o-mini<br/>(OpenAI)
    participant GPT_img as gpt-image-1<br/>(OpenAI)

    User->>Browser: Upload subject photo + reference
    Browser->>Browser: Client compress<br/>max 1280px · 88% quality

    Browser->>API: POST /api/transform<br/>FormData: image1, image2, jobId, intensity
    activate API

    API->>Storage: Upload subject photo<br/>images/{userId}/transform/{jobId}/image1
    Storage-->>API: subject_url

    API->>Storage: Upload reference photo<br/>images/{userId}/transform/{jobId}/image2
    Storage-->>API: reference_url

    API-->>Browser: SSE event: uploading ✓

    API->>GPT_mini: Analyze food image<br/>→ dish type, quality score,<br/>10 editing parameters
    GPT_mini-->>API: food_analysis JSON

    API-->>Browser: SSE event: analyzing reference ✓

    API->>GPT_mini: Analyze reference image<br/>→ style category (5 types),<br/>atmosphere description
    GPT_mini-->>API: style_description

    API-->>Browser: SSE event: applying style transfer ✓

    API->>GPT_img: Edit subject with style prompt<br/>intensity weighting +<br/>editing_plan from food_analysis
    GPT_img-->>API: transformed image (base64)

    API->>Storage: Upload output image<br/>images/{userId}/transform/{jobId}/output
    Storage-->>API: output_url

    API->>DB: INSERT jobs<br/>status=done, output_url,<br/>food_analysis
    DB-->>API: ok

    API-->>Browser: SSE event: done<br/>{ outputUrl, foodAnalysis }
    deactivate API

    Browser->>User: Show result +<br/>version strip +<br/>food analysis panel
```

---

## 2. Video Generation — Single Clip

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant GenAPI as Next.js<br/>/api/video/generate
    participant StatusAPI as Next.js<br/>/api/video/status
    participant Storage as Supabase<br/>Storage
    participant DB as Supabase<br/>DB
    participant Replicate as Real-ESRGAN<br/>(Replicate)
    participant GPT_mini as GPT-4o-mini<br/>(OpenAI)
    participant GPT_img as gpt-image-1<br/>(OpenAI)
    participant Kling as Kling v3 API

    User->>Browser: Upload food photo,<br/>select showcase type
    Browser->>Browser: Client compress<br/>max 2048px

    Browser->>GenAPI: POST /api/video/generate<br/>image, showcase, duration, dishName
    activate GenAPI

    GenAPI->>Storage: Upload food photo
    Storage-->>GenAPI: subject_url

    GenAPI-->>Browser: SSE event: uploading ✓

    alt Image below 1080p
        GenAPI->>Replicate: Real-ESRGAN upscale
        Replicate-->>GenAPI: upscaled image URL
    end

    GenAPI->>GPT_mini: Analyze dish<br/>→ motion description,<br/>physics exclusions
    GPT_mini-->>GenAPI: dish_analysis

    GenAPI-->>Browser: SSE event: analyzing dish ✓

    opt Style reference provided
        GenAPI->>GPT_mini: Analyze reference style
        GPT_mini-->>GenAPI: atmosphere description
        GenAPI-->>Browser: SSE event: analyzing style ✓

        GenAPI->>GPT_img: Apply style transfer
        GPT_img-->>GenAPI: styled image
        GenAPI->>Storage: Upload styled image
        GenAPI-->>Browser: SSE event: transforming ✓
    end

    GenAPI->>Kling: POST image2video<br/>showcase-specific camera prompt +<br/>movement spec + dish description
    Kling-->>GenAPI: { task_id }

    GenAPI->>DB: INSERT video_jobs<br/>status=processing, task_id
    DB-->>GenAPI: ok

    GenAPI-->>Browser: SSE event: done<br/>{ taskId, videoJobId }
    deactivate GenAPI

    loop Poll every 4 seconds
        Browser->>StatusAPI: GET /api/video/status<br/>?taskId&videoJobId
        StatusAPI->>Kling: GET task status
        Kling-->>StatusAPI: { status, video_url }

        alt status = processing
            StatusAPI-->>Browser: { status: processing }
            Browser->>Browser: Fill progress bar slowly
        else status = done
            StatusAPI->>Storage: Upload final video
            StatusAPI->>DB: UPDATE video_jobs<br/>status=done, video_url
            StatusAPI-->>Browser: { status: done, videoUrl }
            Browser->>User: Show video player +<br/>Download button
        else status = failed
            StatusAPI->>DB: UPDATE video_jobs<br/>status=failed
            StatusAPI-->>Browser: { status: failed, error }
            Browser->>User: Show error + retry
        end
    end
```

---

## 3. Video Generation — Combo (Multi-Clip)

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant GenAPI as Next.js<br/>/api/video/generate
    participant StatusAPI as Next.js<br/>/api/video/status
    participant StitchAPI as Next.js<br/>/api/video/stitch
    participant Kling as Kling v3 API
    participant FFmpeg as FFmpeg<br/>(local)
    participant Storage as Supabase<br/>Storage
    participant DB as Supabase<br/>DB

    User->>Browser: Select Combo +<br/>choose clips + durations

    Browser->>GenAPI: POST /api/video/generate<br/>clipDurations JSON<br/>e.g. {hero:5, orbit:5, detail:5}
    Note over GenAPI: Same upload + analysis<br/>pipeline as single clip

    loop For each active clip type
        GenAPI->>Kling: POST image2video<br/>clip-specific prompt
        Kling-->>GenAPI: { task_id_N }
    end

    GenAPI-->>Browser: SSE done<br/>{ clipTaskIds: [id1, id2, id3] }

    loop Poll every 4 seconds
        loop For each taskId
            Browser->>StatusAPI: GET status?taskId=idN
            StatusAPI->>Kling: GET task status
            Kling-->>StatusAPI: { status, video_url }
            StatusAPI-->>Browser: { status, videoUrl }
        end
        Browser->>Browser: Track completion count<br/>show "2 / 3 clips done"
    end

    Note over Browser: All clips done

    Browser->>StitchAPI: POST /api/video/stitch<br/>videoUrls[], fadeDuration=0.5
    activate StitchAPI

    loop For each clip URL
        StitchAPI->>StitchAPI: Download clip<br/>to local temp file
    end

    StitchAPI->>FFmpeg: Concatenate with xfade filter<br/>libx264 · CRF 18 · fast preset
    FFmpeg-->>StitchAPI: final.mp4

    StitchAPI->>Storage: Upload final.mp4
    Storage-->>StitchAPI: final_url

    StitchAPI->>DB: UPDATE video_jobs<br/>status=done, video_url=final_url
    StitchAPI-->>Browser: { videoUrl }
    deactivate StitchAPI

    Browser->>User: Show video player +<br/>Download MP4
```

---

## 4. Review Reply — Single

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant SuggestAPI as Next.js<br/>/api/gmb/suggest-reply
    participant RefineAPI as Next.js<br/>/api/gmb/suggest-reply/refine
    participant ReplyAPI as Next.js<br/>/api/gmb/reply
    participant DB as Supabase DB
    participant GPT as GPT-4o<br/>(OpenAI)
    participant Google as Google<br/>Reviews API

    User->>Browser: Open review,<br/>select style + length

    Browser->>DB: GET recent 6 replies<br/>for this location
    DB-->>Browser: recentReplies[]

    Browser->>SuggestAPI: POST suggest-reply<br/>reviewText, starRating, keywords,<br/>context, promptHints, recentReplies
    activate SuggestAPI

    SuggestAPI->>DB: Fetch last 6 posted replies<br/>(cross-review diversity)
    DB-->>SuggestAPI: recentReplies[]

    SuggestAPI->>GPT: Generate 5 reply variations<br/>temp=0.9, json_object mode
    GPT-->>SuggestAPI: { replies: [5 strings] }

    SuggestAPI->>SuggestAPI: stripTagQuestions()<br/>filterBannedWords()<br/>enforceLength()

    SuggestAPI-->>Browser: { replies: [5 cleaned strings] }
    deactivate SuggestAPI

    Browser->>User: Show 5 reply options

    User->>Browser: Select preferred reply

    Browser->>RefineAPI: POST suggest-reply/refine<br/>selectedReply + same context
    activate RefineAPI

    RefineAPI->>GPT: Analyze selected style +<br/>generate 5 refined variations<br/>temp=0.85
    GPT-->>RefineAPI: { insight, replies: [5 strings] }

    RefineAPI->>RefineAPI: stripTagQuestions()<br/>filterBannedWords()<br/>enforceLength()

    RefineAPI-->>Browser: { insight, replies: [5 strings] }
    deactivate RefineAPI

    Browser->>User: Show insight +<br/>5 refined options

    User->>Browser: Select final reply + confirm

    Browser->>ReplyAPI: POST /api/gmb/reply<br/>{ reviewName, comment }
    activate ReplyAPI

    ReplyAPI->>DB: getValidAccessToken(userId)<br/>refresh if expired
    DB-->>ReplyAPI: access_token

    ReplyAPI->>Google: PUT reviews/{name}/reply<br/>Try v1 first, fallback v4
    Google-->>ReplyAPI: 200 OK or error

    alt 200 OK
        ReplyAPI->>DB: UPDATE gmb_reviews<br/>replied=true, reply_text
        ReplyAPI-->>Browser: { ok: true }
        Browser->>User: ✓ Reply posted
    else 404 NOT_FOUND
        ReplyAPI->>DB: UPDATE gmb_reviews<br/>removed_from_google=true
        ReplyAPI-->>Browser: { skipped: true }
        Browser->>User: Review deleted on Google
    else Other error
        ReplyAPI-->>Browser: { error: message }
        Browser->>User: Show error
    end
    deactivate ReplyAPI
```

---

## 5. Bulk Reply

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant ReviewsAPI as Next.js<br/>/api/gmb/reviews
    participant SuggestAPI as Next.js<br/>/api/gmb/suggest-reply
    participant ReplyAPI as Next.js<br/>/api/gmb/reply
    participant DB as Supabase DB
    participant GPT as GPT-4o<br/>(OpenAI)
    participant Google as Google<br/>Reviews API

    User->>Browser: Configure bulk options<br/>time · count · stars · style · skip toggle

    Browser->>ReviewsAPI: GET /api/gmb/reviews<br/>unreplied=true · since · filter
    ReviewsAPI->>DB: SELECT reviews<br/>replied=false + filters
    DB-->>ReviewsAPI: reviews[]
    ReviewsAPI-->>Browser: { reviews[] }

    Browser->>Browser: Apply star filter +<br/>skip no-comment filter +<br/>count limit

    loop For each review (sequential)
        Browser->>SuggestAPI: POST suggest-reply<br/>review + style + keywords + context
        SuggestAPI->>GPT: Generate 5 variations
        GPT-->>SuggestAPI: replies[]
        SuggestAPI->>SuggestAPI: Server-side cleanup
        SuggestAPI-->>Browser: { replies[] }
        Browser->>Browser: Store replies[0] as draft<br/>Update progress bar
    end

    Browser->>User: Show confirm screen<br/>all drafts editable

    User->>Browser: Review + edit + confirm

    loop For each item with reply (sequential)
        Browser->>ReplyAPI: POST /api/gmb/reply<br/>{ reviewName, comment }
        ReplyAPI->>DB: getValidAccessToken
        DB-->>ReplyAPI: token

        ReplyAPI->>Google: PUT reply
        Google-->>ReplyAPI: result

        alt 200 OK
            ReplyAPI->>DB: UPDATE replied=true
            ReplyAPI-->>Browser: { ok: true }
            Browser->>Browser: ✓ Posted badge
        else 404
            ReplyAPI->>DB: UPDATE removed_from_google=true
            ReplyAPI-->>Browser: { skipped: true }
            Browser->>Browser: — Skipped badge
        else Error
            ReplyAPI-->>Browser: { error }
            Browser->>Browser: ✗ Failed badge
        end

        Browser->>Browser: Update post progress bar
    end

    Browser->>User: Done summary<br/>N posted · N skipped · N failed
```

---

## 6. Reviews Sync from Google

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant API as Next.js<br/>/api/gmb/reviews POST
    participant DB as Supabase DB
    participant Google as Google<br/>Reviews API v1/v4

    User->>Browser: Click "Sync from Google"

    Browser->>API: POST /api/gmb/reviews<br/>{ locationName }
    activate API

    API->>DB: getValidAccessToken(userId)
    DB-->>API: access_token

    loop Paginated fetch (until no nextPageToken)
        alt First page
            API->>Google: GET reviews?pageSize=50<br/>Try v1 first
            alt v1 success
                Google-->>API: { reviews[], nextPageToken }<br/>Lock to v1
            else v1 fails → try v4
                Google-->>API: { reviews[], nextPageToken }<br/>Lock to v4
            end
        else Subsequent pages
            API->>Google: GET reviews?pageToken=xxx<br/>Locked API version only
            Google-->>API: { reviews[], nextPageToken }
        end
        API->>API: Accumulate allReviews[]
    end

    loop Upsert in chunks of 100
        API->>DB: UPSERT gmb_reviews<br/>onConflict: review_name
    end

    API->>DB: SELECT review_names<br/>where removed_from_google=false
    DB-->>API: cachedNames[]

    API->>API: Find names in cache<br/>NOT in Google results

    alt Removed reviews found
        API->>DB: UPDATE removed_from_google=true<br/>for missing reviews
    end

    API-->>Browser: { synced: N, removedCount: N }
    deactivate API

    Browser->>API: GET /api/gmb/reviews<br/>page=0 (reload)
    API->>DB: SELECT + COUNT queries<br/>(replied · unreplied · removed)
    DB-->>API: reviews[] + stats
    API-->>Browser: { reviews, total,<br/>repliedCount, unrepliedCount, removedCount }

    Browser->>User: Updated dashboard<br/>stats + review list
```
