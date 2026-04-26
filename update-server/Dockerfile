FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./

# 创建 public 目录用于挂载更新包
RUN mkdir -p /app/public

EXPOSE 10024

CMD ["node", "server.js"]
