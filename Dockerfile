# ベースイメージとして軽量なNginx（Alpine Linux版）を使用
FROM nginx:alpine

# カスタムのNginx設定ファイルをデフォルト設定の位置にコピー
COPY default.conf /etc/nginx/conf.d/default.conf

# カレントディレクトリにあるHTML/JS/CSSファイルを、Nginxの公開用ディレクトリにコピー
COPY ./ /usr/share/nginx/html/

# コンテナがリッスンするポートを明示
EXPOSE 80
