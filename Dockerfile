FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

RUN apt-get update && apt-get install -y \
  git \
  curl \
  wget \
  jq \
  gosu \
  ripgrep \
  vim \
  nano \
  ca-certificates \
  python3 \
  python3-pip \
  build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json .npmrc ./
RUN npm install

COPY . .
RUN npm run build

RUN chmod +x /app/scripts/docker-entrypoint.sh

EXPOSE 9999

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
