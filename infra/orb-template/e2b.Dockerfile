FROM debian:12

ARG BUN_VERSION=1.3.14
ENV DEBIAN_FRONTEND=noninteractive
ENV BUN_INSTALL=/opt/bun
ENV PATH="/opt/rika/bin:/usr/local/bin:/opt/bun/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates git tmux ripgrep jq unzip openssh-client gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && mkdir -p /opt/bun \
  && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
  && ln -sf /opt/bun/bin/bun /usr/local/bin/bun \
  && ln -sf /opt/bun/bin/bunx /usr/local/bin/bunx \
  && useradd --create-home --shell /bin/bash user \
  && mkdir -p /opt/rika/bin /opt/rika/share/rika /home/user/repo \
  && printf 'new-session -A -s rika\n' > /home/user/.tmux.conf \
  && chmod -R a+rx /opt/bun \
  && chown -R user:user /home/user \
  && rm -rf /var/lib/apt/lists/*

COPY .build/rika/bin/rika /opt/rika/bin/rika
COPY .build/rika/share/ /opt/rika/share/rika/

RUN chmod +x /opt/rika/bin/rika \
  && ln -sf /opt/rika/bin/rika /usr/local/bin/rika

WORKDIR /home/user/repo
USER user
