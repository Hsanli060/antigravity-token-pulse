use crate::models::{now_unix, ModelQuota, QuotaBucket, QuotaData, QuotaGroup};
use crate::oauth::{build_http_client, hub_user_agent};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

const LOAD_PROJECT_ENDPOINTS: [&str; 3] = [
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
    "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
];

const QUOTA_API_ENDPOINTS: [&str; 3] = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
    "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
];

const QUOTA_SUMMARY_ENDPOINTS: [&str; 3] = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
];

#[derive(Debug, Deserialize)]
struct Tier {
    #[serde(rename = "isDefault")]
    is_default: Option<bool>,
    id: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LoadProjectResponse {
    #[serde(rename = "cloudaicompanionProject")]
    project_id: Option<String>,
    #[serde(rename = "currentTier")]
    current_tier: Option<Tier>,
    #[serde(rename = "paidTier")]
    paid_tier: Option<Tier>,
    #[serde(rename = "allowedTiers")]
    allowed_tiers: Option<Vec<Tier>>,
    #[serde(rename = "ineligibleTiers")]
    ineligible_tiers: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
struct QuotaInfo {
    #[serde(rename = "remainingFraction")]
    remaining_fraction: Option<f64>,
    #[serde(rename = "resetTime")]
    reset_time: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ModelInfo {
    #[serde(rename = "quotaInfo")]
    quota_info: Option<QuotaInfo>,
}

#[derive(Debug, Deserialize)]
struct QuotaResponse {
    #[serde(default)]
    models: HashMap<String, ModelInfo>,
}

#[derive(Debug, Deserialize)]
struct SummaryBucketRaw {
    #[serde(rename = "bucketId")]
    bucket_id: Option<String>,
    window: Option<String>,
    #[serde(rename = "remainingFraction")]
    remaining_fraction: Option<f64>,
    #[serde(rename = "resetTime")]
    reset_time: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SummaryGroupRaw {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    description: Option<String>,
    #[serde(default)]
    buckets: Vec<SummaryBucketRaw>,
}

#[derive(Debug, Deserialize)]
struct SummaryResponse {
    #[serde(default)]
    groups: Vec<SummaryGroupRaw>,
}

fn tier_label(t: &Tier) -> Option<String> {
    t.name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| t.id.as_deref().map(str::trim).filter(|s| !s.is_empty()))
        .map(str::to_string)
}

fn extract_subscription_tier(data: &LoadProjectResponse) -> Option<String> {
    if let Some(paid) = data.paid_tier.as_ref().and_then(tier_label) {
        return Some(paid);
    }
    let ineligible = data
        .ineligible_tiers
        .as_ref()
        .is_some_and(|v| !v.is_empty());
    let default_allowed = data.allowed_tiers.as_ref().and_then(|list| {
        list.iter()
            .find(|t| t.is_default == Some(true))
            .and_then(tier_label)
    });
    if !ineligible {
        data.current_tier
            .as_ref()
            .and_then(tier_label)
            .or(default_allowed)
    } else {
        default_allowed
            .or_else(|| data.current_tier.as_ref().and_then(tier_label))
            .map(|l| format!("{l} (Restricted)"))
    }
}

pub async fn fetch_project_and_tier(access_token: &str) -> (Option<String>, Option<String>) {
    let Ok(client) = build_http_client(15) else {
        return (None, None);
    };
    let ua = hub_user_agent();
    let meta = json!({"metadata": {"ideType": "ANTIGRAVITY"}});
    for ep in LOAD_PROJECT_ENDPOINTS {
        if let Ok(resp) = client
            .post(ep)
            .bearer_auth(access_token)
            .header(reqwest::header::USER_AGENT, &ua)
            .json(&meta)
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<LoadProjectResponse>().await {
                    let tier = extract_subscription_tier(&data);
                    return (data.project_id, tier);
                }
            }
        }
    }
    (None, None)
}

fn has_gemini_group(groups: &[QuotaGroup]) -> bool {
    groups.iter().any(|g| {
        let name = g.display_name.to_ascii_lowercase();
        (name.contains("gemini") && !name.contains("argon") && !name.contains("carbon"))
            || g.buckets.iter().any(|b| {
                let id = b.bucket_id.to_ascii_lowercase();
                id.starts_with("gemini-") && !id.contains("argon") && !id.contains("carbon")
            })
    })
}

async fn fetch_quota_summary(
    client: &reqwest::Client,
    access_token: &str,
    project_id: Option<&str>,
    ua: &str,
) -> Option<Vec<QuotaGroup>> {
    let proj = project_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("aicode-consumers");
    let primary_payload = json!({ "project": proj });
    let mut partial: Option<Vec<QuotaGroup>> = None;

    for ep in QUOTA_SUMMARY_ENDPOINTS {
        let attempts = [
            (ua, primary_payload.clone()),
            ("antigravity", primary_payload.clone()),
            (ua, json!({})),
        ];
        for (idx, (attempt_ua, payload)) in attempts.iter().enumerate() {
            let Ok(resp) = client
                .post(ep)
                .bearer_auth(access_token)
                .header(reqwest::header::USER_AGENT, *attempt_ua)
                .json(payload)
                .send()
                .await
            else {
                break;
            };
            let status = resp.status();
            if status == reqwest::StatusCode::FORBIDDEN && idx + 1 < attempts.len() {
                continue;
            }
            if !status.is_success() {
                break;
            }
            let Ok(raw) = resp.json::<SummaryResponse>().await else {
                break;
            };
            let groups: Vec<QuotaGroup> = raw
                .groups
                .into_iter()
                .map(|g| QuotaGroup {
                    display_name: g.display_name.unwrap_or_default(),
                    description: g.description,
                    buckets: g
                        .buckets
                        .into_iter()
                        .map(|b| {
                            let known = b
                                .remaining_fraction
                                .is_some_and(|f| f.is_finite() && (0.0..=1.0).contains(&f));
                            QuotaBucket {
                                bucket_id: b.bucket_id.unwrap_or_default(),
                                window: b.window.unwrap_or_default(),
                                remaining_fraction: b.remaining_fraction.unwrap_or(0.0),
                                remaining_fraction_known: Some(known),
                                reset_time: b.reset_time.unwrap_or_default(),
                                display_name: b.display_name,
                                description: b.description,
                            }
                        })
                        .collect(),
                })
                .collect();
            if groups.iter().all(|g| g.buckets.is_empty()) {
                break;
            }
            if has_gemini_group(&groups) {
                return Some(groups);
            }
            if partial.is_none() {
                partial = Some(groups);
            }
            if *attempt_ua == "antigravity" && idx + 1 < attempts.len() {
                continue;
            }
            break;
        }
    }
    partial
}

pub async fn fetch_quota(
    access_token: &str,
    cached_project_id: Option<&str>,
) -> Result<(QuotaData, Option<String>), String> {
    let (fetched_pid, tier) = fetch_project_and_tier(access_token).await;
    let project_id = fetched_pid.or_else(|| cached_project_id.map(str::to_string));
    let client = build_http_client(20)?;
    let ua = hub_user_agent();
    let base_payload = if let Some(ref pid) = project_id {
        json!({ "project": pid })
    } else {
        json!({})
    };

    let mut last_err = "Quota fetch failed".to_string();
    for (idx, ep) in QUOTA_API_ENDPOINTS.iter().enumerate() {
        let has_next = idx + 1 < QUOTA_API_ENDPOINTS.len();
        let mut payload = base_payload.clone();
        let mut retried_no_proj = false;
        loop {
            match client
                .post(*ep)
                .bearer_auth(access_token)
                .header(reqwest::header::USER_AGENT, &ua)
                .json(&payload)
                .send()
                .await
            {
                Ok(resp) => {
                    let status = resp.status();
                    if status == reqwest::StatusCode::FORBIDDEN {
                        if payload.get("project").is_some() && !retried_no_proj {
                            payload = json!({});
                            retried_no_proj = true;
                            continue;
                        }
                        if has_next {
                            break;
                        }
                        let mut q = QuotaData::new();
                        q.is_forbidden = true;
                        q.subscription_tier = tier.clone();
                        return Ok((q, project_id));
                    }
                    if !status.is_success() {
                        last_err = format!("Quota API HTTP {status}");
                        if has_next {
                            break;
                        }
                        return Err(last_err);
                    }
                    let parsed = resp
                        .json::<QuotaResponse>()
                        .await
                        .map_err(|e| format!("Quota JSON parse failed: {e}"))?;
                    let mut q = QuotaData::new();
                    q.last_updated = now_unix();
                    q.subscription_tier = tier.clone();
                    for (name, info) in parsed.models {
                        if !["gemini", "claude", "gpt", "image", "imagen"]
                            .iter()
                            .any(|p| name.starts_with(p))
                        {
                            continue;
                        }
                        let frac = info
                            .quota_info
                            .as_ref()
                            .and_then(|qi| qi.remaining_fraction)
                            .filter(|f| f.is_finite() && (0.0..=1.0).contains(f));
                        q.models.push(ModelQuota {
                            name,
                            percentage: frac.map(|f| (f * 100.0).round() as i32).unwrap_or(0),
                            percentage_known: Some(frac.is_some()),
                            reset_time: info
                                .quota_info
                                .and_then(|qi| qi.reset_time)
                                .unwrap_or_default(),
                        });
                    }
                    q.quota_groups =
                        fetch_quota_summary(&client, access_token, project_id.as_deref(), &ua)
                            .await;
                    return Ok((q, project_id));
                }
                Err(e) => {
                    last_err = format!("Quota network error: {e}");
                    break;
                }
            }
        }
    }
    Err(last_err)
}
