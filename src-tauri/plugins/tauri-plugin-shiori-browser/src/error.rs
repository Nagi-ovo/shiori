use serde::{Serialize, Serializer};

#[derive(Debug)]
pub enum Error {
    /// Any failure forwarding to / from the native plugin, flattened to a
    /// message so the crate has no hard dependency on the exact tauri mobile
    /// error type path (which is feature/cfg gated).
    Runtime(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Runtime(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for Error {}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
