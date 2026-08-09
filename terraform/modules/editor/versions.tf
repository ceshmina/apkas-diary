terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"

      # **us-east-1 のプロバイダを受け取らない。**
      # 配信の前段が CloudFront ではなく API Gateway の HTTP API なので、
      # 証明書はこの環境と同じリージョンのもので足りる（design.md 決定2）。
    }

    # Lambda の placeholder をインラインの内容から組み立てるためだけに使う。
    # zip をリポジトリに置かずに済ませる。
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}
