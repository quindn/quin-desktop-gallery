use axum::response::Html;

const INDEX_HTML: &str = include_str!("web/index.html");

pub async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}
