//! API key 环境变量名称列表与过滤逻辑。

const API_KEY_ENV_VARS: &[&str] = &["CRISH_API_KEY", "FLOWBIT_API_KEY", "OPENAI_API_KEY"];
const API_BASE_URL_ENV_VARS: &[&str] = &[
    "CRISH_API_BASE_URL",
    "FLOWBIT_API_BASE_URL",
    "OPENAI_BASE_URL",
];
const MODEL_ENV_VARS: &[&str] = &["CRISH_MODEL", "FLOWBIT_MODEL", "OPENAI_MODEL"];
const CREDENTIAL_MODE_ENV_VARS: &[&str] = &[
    "CRISH_CREDENTIAL_MODE",
    "FLOWBIT_CREDENTIAL_MODE",
    "CRISH_PROVIDER_CREDENTIAL_MODE",
    "FLOWBIT_PROVIDER_CREDENTIAL_MODE",
];

pub(crate) fn api_key_env_var_names() -> &'static [&'static str] {
    API_KEY_ENV_VARS
}

pub(crate) fn api_base_url_env_var_names() -> &'static [&'static str] {
    API_BASE_URL_ENV_VARS
}

pub(crate) fn model_env_var_names() -> &'static [&'static str] {
    MODEL_ENV_VARS
}

pub(crate) fn credential_mode_env_var_names() -> &'static [&'static str] {
    CREDENTIAL_MODE_ENV_VARS
}
