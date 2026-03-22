FROM golang:1.22-bookworm AS builder
RUN go install github.com/steveyegge/beads/cmd/bd@latest

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /go/bin/bd /usr/local/bin/bd
WORKDIR /workspace
# Init beads on first run if not already initialized
CMD ["sh", "-c", "cd /workspace && (test -d .beads || bd init --stealth) && bd daemon start --local"]
