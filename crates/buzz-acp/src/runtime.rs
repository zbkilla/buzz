//! Shared agent capabilities. Intake and scheduling belong to each entry point;
//! environment, credentials, adapter settings and prompt equipment belong here.
use crate::{
    acp, build_mcp_servers, config::Config, current_working_directory, git, observer, pool, relay,
    resolve_agent_owner, AcpClient, PromptContext,
};
use anyhow::Result;
use std::{collections::HashMap, time::Duration};
use uuid::Uuid;

pub(crate) enum SessionMode {
    Conversation,
    Task,
}

/// Own shared launch resources until all adapter work has been drained.
/// Add new runtime capabilities here, not separately to the CLI entry points.
pub(crate) struct AgentRuntime {
    config: Config,
    _git_environment: git::GitEnvironment,
}

impl AgentRuntime {
    pub(crate) fn prepare(mut config: Config) -> Result<Self> {
        let git_environment = git::GitEnvironment::for_config(&mut config)?;
        Ok(Self {
            config,
            _git_environment: git_environment,
        })
    }

    pub(crate) fn config(&self) -> &Config {
        &self.config
    }

    pub(crate) fn startup(&self, observer: Option<observer::ObserverHandle>) -> PoolStartup {
        PoolStartup::from_config(&self.config, observer)
    }

    pub(crate) fn prompt_context(
        &self,
        rest: relay::RestClient,
        channels: HashMap<Uuid, relay::ChannelInfo>,
        mode: SessionMode,
    ) -> Result<PromptContext> {
        make_prompt_context(&self.config, rest, channels, mode)
    }
}

#[derive(Clone)]
pub(crate) struct PoolStartup {
    pub(crate) agents: u32,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) extra_env: Vec<(String, String)>,
    pub(crate) has_generated_codex_config: bool,
    pub(crate) model: Option<String>,
    pub(crate) effort_level: Option<String>,
    pub(crate) observer: Option<observer::ObserverHandle>,
    pub(crate) permission_policy: acp::PermissionPolicy,
}

impl PoolStartup {
    fn from_config(config: &Config, observer: Option<observer::ObserverHandle>) -> Self {
        Self {
            agents: config.agents,
            command: config.agent_command.clone(),
            args: config.agent_args.clone(),
            extra_env: config.persona_env_vars.clone(),
            has_generated_codex_config: config.has_generated_codex_config,
            model: config.model.clone(),
            effort_level: config.effort_level.clone(),
            observer,
            permission_policy: config.permission_mode.permission_policy(),
        }
    }

    /// Spawn one agent process for this pool, with the configured permission
    /// policy already applied. Every production spawn goes through here.
    pub(crate) async fn spawn_agent(&self) -> Result<AcpClient, acp::AcpError> {
        let mut client = AcpClient::spawn(
            &self.command,
            &self.args,
            &self.extra_env,
            self.has_generated_codex_config,
        )
        .await?;
        client.set_permission_policy(self.permission_policy);
        Ok(client)
    }
}

fn make_prompt_context(
    config: &Config,
    rest_client: relay::RestClient,
    channels: HashMap<Uuid, relay::ChannelInfo>,
    mode: SessionMode,
) -> Result<PromptContext> {
    let base_prompt_content = config.base_prompt_content.as_ref();
    let cwd = current_working_directory()?;
    Ok(PromptContext {
        mcp_servers: build_mcp_servers(config),
        initial_message: config.initial_message.clone(),
        idle_timeout: Duration::from_secs(config.idle_timeout_secs),
        max_turn_duration: Duration::from_secs(config.max_turn_duration_secs),
        turn_liveness_interval: Duration::from_secs(config.turn_liveness_secs),
        dedup_mode: config.dedup_mode,
        system_prompt: config.system_prompt.clone(),
        session_title: config.session_title.clone(),
        team_instructions: config.team_instructions.clone(),
        base_prompt: if config.no_base_prompt {
            None
        } else {
            // Build standing context once under the configured policy, before
            // any session/new. Both modern ACP and legacy first-turn framing
            // consume this same assembled base (including custom base files).
            let base = base_prompt_content
                .map(String::as_str)
                .unwrap_or(include_str!("base_prompt.md"));
            Some(if matches!(mode, SessionMode::Task) {
                format!("{base}\n\n{}", include_str!("session_model_task.md"))
            } else {
                config.session_policy.append_session_model(base)
            })
        },
        heartbeat_prompt: config.heartbeat_prompt.clone(),
        cwd,
        rest_client: rest_client.clone(),
        channel_info: pool::ChannelInfoResolver::new(channels, rest_client),
        context_message_limit: config.context_message_limit,
        max_turns_per_session: config.max_turns_per_session,
        permission_mode: config.permission_mode,
        agent_keys: config.keys.clone(),
        agent_owner_pubkey: resolve_agent_owner(config)
            .as_deref()
            .and_then(|hex| nostr::PublicKey::from_hex(hex).ok()),
        memory_enabled: config.memory_enabled,
        harness_name: crate::config::normalize_agent_command_identity(&config.agent_command),
        relay_url: config.relay_url.clone(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::config::PermissionMode;

    /// A fake agent that answers one prompt, asking permission once with
    /// `options` first, and records the harness's answer in `out`.
    fn startup_for(mode: PermissionMode, options: &str, out: &std::path::Path) -> PoolStartup {
        let request = format!(
            r#"{{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{{"sessionId":"s1","toolCall":{{"toolCallId":"t1"}},"options":{options}}}}}"#
        );
        let script = format!(
            r#"read -r REQ
ID=$(printf '%s' "$REQ" | sed -E 's/.*"id":([0-9]+).*/\1/')
printf '%s\n' '{request}'
read -r ANSWER
printf '%s\n' "$ANSWER" > '{out}'
echo '{{"jsonrpc":"2.0","id":'"$ID"',"result":{{"stopReason":"end_turn"}}}}'
sleep 1"#,
            out = out.display()
        );
        PoolStartup {
            agents: 1,
            command: "bash".into(),
            args: vec!["-c".into(), script],
            extra_env: Vec::new(),
            has_generated_codex_config: false,
            model: None,
            effort_level: None,
            observer: None,
            permission_policy: mode.permission_policy(),
        }
    }

    async fn harness_answer(mode: PermissionMode, options: &str) -> serde_json::Value {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("answer.json");
        let mut client = startup_for(mode, options, &out)
            .spawn_agent()
            .await
            .expect("spawn fake agent");
        let stop = client
            .session_prompt_with_idle_timeout(
                "s1",
                "hello",
                Duration::from_secs(5),
                Duration::from_secs(10),
            )
            .await
            .expect("prompt completes");
        assert_eq!(stop, acp::StopReason::EndTurn);
        client.shutdown().await;
        let answer = std::fs::read_to_string(&out).expect("fake agent recorded the answer");
        serde_json::from_str(answer.trim()).expect("answer is JSON")
    }

    const ALLOW_AND_REJECT: &str = r#"[{"optionId":"opt-allow","name":"Allow","kind":"allow_once"},{"optionId":"opt-reject","name":"Reject","kind":"reject_once"}]"#;
    const ALLOW_ONLY: &str = r#"[{"optionId":"opt-allow","name":"Allow","kind":"allow_once"}]"#;

    #[tokio::test]
    async fn dont_ask_pool_agent_rejects_permission_requests() {
        let answer = harness_answer(PermissionMode::DontAsk, ALLOW_AND_REJECT).await;
        assert_eq!(answer["id"], "perm-1");
        assert_eq!(answer["result"]["outcome"]["outcome"], "selected");
        assert_eq!(answer["result"]["outcome"]["optionId"], "opt-reject");
    }

    #[tokio::test]
    async fn plan_pool_agent_cancels_when_only_allow_is_offered() {
        let answer = harness_answer(PermissionMode::Plan, ALLOW_ONLY).await;
        assert_eq!(answer["id"], "perm-1");
        assert_eq!(answer["result"]["outcome"]["outcome"], "cancelled");
    }

    #[tokio::test]
    async fn bypass_pool_agent_still_auto_approves() {
        let answer = harness_answer(PermissionMode::BypassPermissions, ALLOW_AND_REJECT).await;
        assert_eq!(answer["result"]["outcome"]["optionId"], "opt-allow");
    }
}
