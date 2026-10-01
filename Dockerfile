# ベースイメージとして軽量なNginx（Alpine Linux版）を使用
FROM nginx:alpine

# カレントディレクトリにあるHTML/JS/CSSファイルを、Nginxの公開用ディレクトリにコピー
COPY ./ /usr/share/nginx/html/

# コンテナがリッスンするポートを明示
EXPOSE 80
