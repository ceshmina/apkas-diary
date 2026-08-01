// CloudFront Function（ビューアリクエスト）
//
// S3 の REST エンドポイントは、サブディレクトリに対する index ドキュメントの
// 解決を行わない。Astro は `/2026/08/01` を `/2026/08/01/index.html` として
// 出力するため、拡張子を持たないパスに `/index.html` を補う。

function handler(event) {
  var request = event.request
  var uri = request.uri

  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html'
    return request
  }

  // 最後のセグメントに `.` が含まれていればファイルとみなし、そのまま通す。
  // `/_astro/index.abc123.css` はここで素通りし、`/2026/08/01` や
  // `/on-this-day/08-01` は index.html を補われる。
  var lastSlash = uri.lastIndexOf('/')
  var lastSegment = uri.slice(lastSlash + 1)

  if (lastSegment.indexOf('.') === -1) {
    request.uri = uri + '/index.html'
  }

  return request
}
