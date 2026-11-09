FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_APP_MODE=development
ARG VITE_PILOT_OPERATOR
ARG VITE_PILOT_CONTACT
ARG VITE_PILOT_PRIVACY_VERSION
ENV VITE_APP_MODE=$VITE_APP_MODE VITE_PILOT_OPERATOR=$VITE_PILOT_OPERATOR VITE_PILOT_CONTACT=$VITE_PILOT_CONTACT VITE_PILOT_PRIVACY_VERSION=$VITE_PILOT_PRIVACY_VERSION
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
