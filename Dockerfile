# ベースイメージとして軽量なNginx（Alpine Linux版）を使用
FROM nginx:alpine

# カスタムのNginx設定ファイルをデフォルト設定の位置にコピー
COPY default.conf /etc/nginx/conf.d/default.conf

# カレントディレクトリにあるHTML/JS/CSSファイルを、Nginxの公開用ディレクトリにコピー
COPY index.html script.js styles.css /usr/share/nginx/html/

# 本番イメージでは HTML コメント（機能構成の手がかりになる）を除去する（ソース側には残す）
RUN sed -i 's/<!--[^>]*-->//g' /usr/share/nginx/html/index.html

# コンテナがリッスンするポートを明示
EXPOSE 80
