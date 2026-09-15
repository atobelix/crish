//! 凭据引用的唯一语法；不读取凭据，也不把模型身份当作文件名。

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialRef {
    Dpapi(uuid::Uuid),
    Env(String),
}

impl CredentialRef {
    pub fn parse(reference: &str) -> Result<Self, String> {
        if let Some(id) = reference.strip_prefix("dpapi:") {
            let id = uuid::Uuid::parse_str(id)
                .map_err(|_| "dpapi 引用必须携带独立 UUID 槽标识".to_owned())?;
            return Ok(Self::Dpapi(id));
        }
        if let Some(name) = reference.strip_prefix("env:") {
            let mut bytes = name.bytes();
            if !bytes
                .next()
                .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
                || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            {
                return Err("env 引用必须显式指定合法变量名".into());
            }
            return Ok(Self::Env(name.to_owned()));
        }
        Err("只接受 dpapi:UUID 或 env:变量名，不接受明文凭据".into())
    }

    pub fn canonical(&self) -> String {
        match self {
            Self::Dpapi(id) => format!("dpapi:{id}"),
            Self::Env(name) => format!("env:{name}"),
        }
    }
}
