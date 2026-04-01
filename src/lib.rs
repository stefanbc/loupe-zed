use zed_extension_api::{self as zed, Command, LanguageServerId, Result, Worktree};

struct LoupeExtension;

impl zed::Extension for LoupeExtension {
    fn new() -> Self {
        LoupeExtension
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        _worktree: &Worktree,
    ) -> Result<Command> {
        let extension_dir = std::env::current_dir().map_err(|e| e.to_string())?;
        let server_path = extension_dir
            .join("lsp/dist/server.js")
            .to_string_lossy()
            .to_string();

        Ok(Command {
            command: zed::node_binary_path()?,
            args: vec![server_path, "--stdio".to_string()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(LoupeExtension);
