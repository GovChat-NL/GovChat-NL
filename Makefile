# Convenience wrapper around the docker compose stack.
# Run `make help` for the list of targets.

COMPOSE := docker compose

.PHONY: help env up up-n8n down logs reload-workflows rebuild-admin check test-beleidskompas generate-stap1

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /: /' | sort

env: ## Create .env from .env.example if it doesn't exist yet
	@test -f .env || (cp .env.example .env && echo "Created .env - fill in the required secrets (see README.md)")

up: env ## Start the full stack
	$(COMPOSE) up -d

up-n8n: env ## Start only n8n and LiteLLM (to test workflows without the full UI)
	$(COMPOSE) up -d n8n-postgres litellm-postgres litellm n8n n8n-runners

down: ## Stop and remove all containers and the network (keeps the data volumes and /opt/librechat)
	$(COMPOSE) down

logs: ## Tail the logs of all services, or of one: make logs service=n8n
	$(COMPOSE) logs -f $(service)

reload-workflows: ## Re-import and publish the workflows from agents/n8n/workflows, then restart n8n
	AGENTS_BOOTSTRAP_FORCE=true $(COMPOSE) up -d --force-recreate n8n-bootstrap
	$(COMPOSE) wait n8n-bootstrap
	$(COMPOSE) restart n8n

rebuild-admin: ## Rebuild and restart the overlay admin
	$(COMPOSE) up -d --build govchat-overlay-admin

check: ## Validate the compose file, the workflow exports and the scripts (no running stack needed)
	$(COMPOSE) --env-file .env.example config --quiet
	node tests/agents/validate-workflows.js
	node --check n8n/bootstrap.js
	node --check services/admin-overlay/admin/server.js

test-beleidskompas: ## Run the Beleidskompas unit tests: step 1 logic and the page (no Docker needed)
	cd agents/beleidskompas && node --test
	cd overlay/src/apps/beleidskompas && node --test

generate-stap1: ## Regenerate beleidskompas-step-stap1.json from agents/beleidskompas
	cd agents/beleidskompas && node generate-workflow.js
